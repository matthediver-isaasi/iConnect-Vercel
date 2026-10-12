import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
import React from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
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

test("quote form omits the redundant tax treatment control without discarding saved metadata", () => {
  const source = readFileSync("client/src/components/sales/QuotesWorkspace.jsx", "utf8");
  assert.doesNotMatch(source, /<Field label="Tax treatment"/);
  for (const tax_treatment of ["exclusive", "inclusive", "exempt"]) {
    assert.equal(mod.exports.normalizeQuote({ id: "quote", tax_treatment }).taxTreatment, tax_treatment);
  }
  assert.match(source, /taxTreatment: form\.taxTreatment/);
});

test("all saved billing address fields survive detail hydration including deliberate clearing", () => {
  const address = { addressee: "Accounts", line1: "10 High Street", line2: "Floor 2", city: "Leeds", region: "Yorkshire", postalCode: "LS1 1AA", country: "UK" };
  for (const address_snapshot of [address, Object.fromEntries(Object.keys(address).map(key => [key, ""]))]) {
    const saved = mod.exports.normalizeQuote({ id: "quote", currentVersion: { version_number: 1, address_snapshot } });
    assert.deepEqual(saved.address, address_snapshot);
  }
  const source = readFileSync("client/src/components/sales/QuotesWorkspace.jsx", "utf8");
  assert.doesNotMatch(source, /setLoadedId\(null\)/);
  assert.match(source, /await refreshSavedQuoteDraft/);
});

test("historical PDF requests explicitly select the version and preserve authenticated access", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const blob = new Blob(["%PDF-fixture"], { type: "application/pdf" });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, blob: async () => blob }; };
  try {
    assert.equal(await mod.exports.quotePdf("quote-id", 2), blob);
    assert.equal(calls[0].url, "/api/sales/quotes/quote-id?action=pdf&version=2");
    assert.equal(calls[0].options.credentials, "include");
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: "Quote version not found" }) });
    await assert.rejects(mod.exports.quotePdf("quote-id", 99), /Quote version not found/);
  } finally { globalThis.fetch = originalFetch; }
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
