import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { build } from "esbuild";
const result = await build({ entryPoints: ["client/src/components/sales/QuotesWorkspace.jsx"], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", alias: { "@": `${process.cwd()}/client/src`, "@shared": `${process.cwd()}/shared` } });
const mod = new Module(`${process.cwd()}/quote-hydration-fixture.cjs`);
mod.paths = Module._nodeModulePaths(process.cwd());
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
