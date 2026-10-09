import test from "node:test";
import assert from "node:assert/strict";
import { decimalToMinor, minorToDecimal, productPricesForEditing, productPricesForSaving, productTaxForSaving, taxPercent } from "./catalogueProductForm.js";
import { taxCodeKey } from "../../lib/salesTaxCodes.js";

test("decimal inputs convert exactly, retaining blank versus zero", () => {
  for (const [input, expected] of [["125.00", 12500], ["0.29", 29], ["0", 0], [".05", 5], ["12.", 1200], [" 12.3 ", 1230], ["0002.01", 201]]) {
    assert.equal(decimalToMinor(input), expected);
  }
  assert.equal(decimalToMinor(""), null);
  assert.equal(decimalToMinor(null), null);
  assert.throws(() => decimalToMinor("", { required: true }));
});

test("invalid precision, signs, notation, separators and unsafe amounts are rejected", () => {
  for (const value of ["1.001", "-1", "-0", "+2", "1e3", "1,200", "NaN", "Infinity", ".", "90071992547409.92"]) {
    assert.throws(() => decimalToMinor(value), value);
  }
  assert.equal(decimalToMinor("90071992547409.91"), Number.MAX_SAFE_INTEGER);
});

test("all stored prices round-trip exactly including the safe integer boundary", () => {
  for (const value of [0, 1, 29, 12500, 238719, Number.MAX_SAFE_INTEGER]) {
    assert.equal(decimalToMinor(minorToDecimal(value)), value);
  }
  const row = { standardPriceMinor: 12500, minimumPriceMinor: null, costMinor: 0 };
  assert.deepEqual(productPricesForSaving(productPricesForEditing(row)), row);
  assert.throws(() => productPricesForSaving({ standardPriceMinor: "12", minimumPriceMinor: "13", costMinor: "" }));
});

test("new products require explicit provider codes; save identity only", () => {
  const items = [{ provider: "xero", id: "vat-sales", name: "Sales VAT", rateBps: 2000, selectable: true }, { provider: "xero", id: "disabled", rateBps: 0, selectable: false }];
  assert.throws(() => productTaxForSaving(null, "", items));
  assert.throws(() => productTaxForSaving(null, taxCodeKey(items[1]), items));
  assert.throws(() => productTaxForSaving(null, taxCodeKey(items[0]), items, false));
  assert.deepEqual(productTaxForSaving(null, taxCodeKey(items[0]), items), { taxCode: { provider: "xero", id: "vat-sales" } });
});

test("edits retain saved tax unchanged when unavailable, but cannot save an invalid changed code", () => {
  const existing = { taxRateBps: 0, taxTreatment: "exempt" };
  assert.deepEqual(productTaxForSaving(existing, "", [], false), {});
  assert.deepEqual(productTaxForSaving({ ...existing, taxCode: { provider: "xero", id: "saved" } }, "", [], false), {});
  assert.throws(() => productTaxForSaving(existing, "missing", [], false));
  assert.equal(taxPercent(0), "0%");
  assert.equal(taxPercent(725), "7.25%");
  assert.equal(taxPercent(null), "Not set");
});
