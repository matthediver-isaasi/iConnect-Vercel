import test from "node:test";
import assert from "node:assert/strict";
import { bundleTaxForSaving } from "./bundleVatForm.js";
import { catalogueCopyForEditing } from "./catalogueProductForm.js";
import { catalogueTaxForNewQuoteLine } from "../../lib/salesTaxCodes.js";

const code = { provider: "xero", id: "EXEMPT", name: "Exempt income", rateBps: 0, selectable: true };
test("bundle VAT creation, replacement and explicit clearing preserve provider identity", () => {
  assert.deepEqual(bundleTaxForSaving(null, code, [code], true), { taxOverride: { provider: "xero", id: "EXEMPT" } });
  assert.deepEqual(bundleTaxForSaving({ taxOverride: code }, null, [], false), { taxOverride: null });
  assert.deepEqual(bundleTaxForSaving({ taxOverride: code }, { ...code }, [], false), {});
  assert.deepEqual(bundleTaxForSaving({}, null, [], false), {});
  assert.throws(() => bundleTaxForSaving(null, code, [], true), /available synced VAT/);
  assert.throws(() => bundleTaxForSaving(null, code, [code], false), /available synced VAT/);
  const qb = { ...code, provider: "quickbooks" };
  assert.throws(() => bundleTaxForSaving(null, qb, [code], true), /available synced VAT/);
});
test("copying a bundle carries its VAT choice without sharing mutable snapshots", () => {
  const copy = catalogueCopyForEditing("bundles", { id: "source", name: "Bundle", taxOverride: code }, "COPY");
  assert.deepEqual(copy.taxOverride, code);
  copy.taxOverride.name = "Changed";
  assert.equal(code.name, "Exempt income");
});
test("choosing another catalogue item applies its bundle override and clears stale line tax", () => {
  assert.deepEqual(catalogueTaxForNewQuoteLine("bundle", { taxOverride: code }),
    { taxCode: code, taxRateBps: 0, legacyTax: false, taxChanged: false });
  const standard = { ...code, rateBps: 2000 };
  assert.equal(catalogueTaxForNewQuoteLine("bundle", { taxOverride: standard }).taxRateBps, 2000);
  assert.equal(catalogueTaxForNewQuoteLine("bundle", {}).taxCode, null);
  assert.equal(catalogueTaxForNewQuoteLine("bundle", {}).taxRateBps, 0);
  assert.equal(catalogueTaxForNewQuoteLine("product", { taxCode: standard, taxRateBps: 2000 }).taxRateBps, 2000);
});
