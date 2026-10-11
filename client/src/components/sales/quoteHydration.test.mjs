import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
const result = await build({ entryPoints: ["client/src/components/sales/QuotesWorkspace.jsx"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` } });
const mod = new Module(`${process.cwd()}/quote-hydration-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
const { MemoryRouter } = mod.require("react-router-dom");
const { QueryClient, QueryClientProvider } = mod.require("@tanstack/react-query");
mod._compile(result.outputFiles[0].text, `${process.cwd()}/quote-hydration-fixture.cjs`);
test("saved quote detail hydrates opportunity, bundle lines, prices and issue permission", () => {
  const version = { version_number: 1, status: "draft", sales_quote_line: [{ id: "line", catalogue_kind: "bundle", catalogue_id: "bundle", standard_unit_price_minor: 4000, quoted_unit_price_minor: 4000 }] };
  const source = { id: "quote", opportunity_id: "opportunity", current_version: 1, currentVersion: version, permissions: { canIssue: true } };
  for (const payload of [source, { ...source, currentVersion: undefined, versions: [version] }]) {
    const quote = mod.exports.normalizeQuote(payload);
    assert.equal(quote.opportunityId, "opportunity");
    assert.equal(quote.lines.length, 1);
    assert.equal(quote.lines[0].type, "bundle");
    assert.equal(quote.lines[0].bundleId, "bundle");
    assert.equal(quote.lines[0].quotedUnitPriceMinor, 4000);
    assert.equal(quote.permissions.canIssue, true);
  }
});

test("opportunity list uses isolated cache entries, includes drafts and formats gross currency", () => {
  globalThis.React = React;
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(["sales-quotes", "", "all", 1, "selected-opportunity"], {
    items: [{ id: "quote-1", quote_number: "Q-SELECTED", currentVersion: { version_number: 1, status: "draft", currency: "GBP", gross_minor: 4800 } }], total: 1,
  });
  cache.setQueryData(["sales-quotes", "", "all", 1, ""], {
    items: [{ id: "other-quote", quote_number: "Q-OTHER" }], total: 1,
  });
  const html = renderToString(React.createElement(QueryClientProvider, { client: cache },
    React.createElement(MemoryRouter, null, React.createElement(mod.exports.QuotesList, { opportunityId: "selected-opportunity" }))));
  assert.match(html, /Q-SELECTED/);
  assert.match(html, /draft/);
  assert.match(html, /48\.00/);
  assert.doesNotMatch(html, /Q-OTHER/);
  assert.match(html, /Create quote/);
  cache.clear();
});
