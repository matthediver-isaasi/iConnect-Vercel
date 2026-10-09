import test from "node:test";
import assert from "node:assert/strict";
import { persistedQuoteLineId, providerTaxOptions, quoteLineIdentityForSaving, quoteLineTaxForSaving, savedLineTaxCode, selectedProviderTaxCode, taxCodeKey } from "./salesTaxCodes.js";

const items = [
  { provider: "xero", id: "OUTPUT", name: "Sales VAT", rateBps: 2000, selectable: true },
  { provider: "xero", id: "OTHER", name: "Other VAT", rateBps: 2000, selectable: true },
  { provider: "quickbooks", id: "OUTPUT", rateBps: 725, selectable: true },
];

test("only persisted UUID line ids are serialized, never local keys or temporary ids", () => {
  const uuid = "af4c62c7-a5d8-46f2-9482-35de27e6d928";
  assert.equal(persistedQuoteLineId({ id: uuid }), uuid);
  assert.equal(persistedQuoteLineId({ id: "temporary-line-1" }), null);
  assert.equal(persistedQuoteLineId({ key: uuid }), null);
  assert.deepEqual(quoteLineIdentityForSaving({ key: uuid }), {});
  assert.deepEqual(quoteLineIdentityForSaving({ id: uuid, key: uuid }), {});
  assert.deepEqual(quoteLineIdentityForSaving({ persistedLineId: "temporary-line-1" }), {});
  assert.deepEqual(quoteLineIdentityForSaving({ persistedLineId: persistedQuoteLineId({ id: uuid }), key: "display-key" }), { id: uuid });
});

test("existing product lines display frozen snapshot identity, not current catalogue code", () => {
  const saved = { kind: "product", catalogue_snapshot: { tax_code: items[0] }, tax_rate_bps: 2000 };
  const currentCatalogueProduct = { taxCode: items[2], taxRateBps: 725 };
  assert.equal(savedLineTaxCode(saved), items[0]);
  assert.notEqual(savedLineTaxCode(saved), currentCatalogueProduct.taxCode);
  assert.deepEqual(quoteLineTaxForSaving({ type: "product", taxCode: savedLineTaxCode(saved), taxRateBps: saved.tax_rate_bps }, items), {});
});

test("identity distinguishes equal percentages and identical ids at different providers", () => {
  for (const code of items) assert.equal(selectedProviderTaxCode(taxCodeKey(code), items), code);
  assert.notEqual(taxCodeKey(items[0]), taxCodeKey(items[2]));
  assert.throws(() => selectedProviderTaxCode("2000", items));
  assert.throws(() => selectedProviderTaxCode(taxCodeKey(items[0]), [{ ...items[0], selectable: false }]));
});

test("options inherit response provider without overwriting per-code identity", () => {
  assert.equal(providerTaxOptions({ provider: "xero", items: [{ id: "ZERO", selectable: true }] })[0].provider, "xero");
  assert.equal(providerTaxOptions({ provider: "xero", items: [items[2]] })[0].provider, "quickbooks");
});

test("saved quote identity comes from snapshot, never a percentage match", () => {
  assert.equal(savedLineTaxCode({ catalogue_snapshot: { tax_code: items[1] }, taxCode: items[0] }), items[1]);
  assert.equal(savedLineTaxCode({ tax_rate_bps: 2000 }), null);
});

test("new free text and bundle lines require a code and send identity only", () => {
  for (const type of ["free_text", "bundle"]) {
    assert.throws(() => quoteLineTaxForSaving({ type, taxRateBps: 2000 }, items));
    assert.deepEqual(quoteLineTaxForSaving({ type, taxChanged: true, taxCode: items[1] }, items), { taxCode: { provider: "xero", id: "OTHER" } });
    assert.throws(() => quoteLineTaxForSaving({ type, taxChanged: true, taxCode: items[1] }, [], false));
  }
});

test("saved unavailable identities and legacy tax survive unrelated edits", () => {
  assert.deepEqual(quoteLineTaxForSaving({ type: "bundle", taxCode: items[0] }, [], false), { taxCode: { provider: "xero", id: "OUTPUT" } });
  for (const type of ["free_text", "bundle", "product"]) {
    assert.deepEqual(quoteLineTaxForSaving({ type, legacyTax: true, taxRateBps: 725 }, [], false), { taxRateBps: 725 });
  }
  assert.deepEqual(quoteLineTaxForSaving({ type: "product", taxCode: items[0] }, [], false), {});
});
