import test from "node:test";
import assert from "node:assert/strict";
import { bundlePricesForEditing, bundlePricesForSaving } from "./catalogueProductForm.js";

test("bundle prices round trip without scaling or rounding existing values", () => {
  for (const value of [0, 1, 29, 12500, 238719, Number.MAX_SAFE_INTEGER]) {
    const row = { sellingPriceMinor: value, minimumPriceMinor: value };
    assert.deepEqual(bundlePricesForSaving(bundlePricesForEditing(row)), row);
  }
  assert.deepEqual(bundlePricesForEditing(), { sellingPriceMinor: "", minimumPriceMinor: "" });
  assert.deepEqual(bundlePricesForSaving({ sellingPriceMinor: "125.00", minimumPriceMinor: "" }), { sellingPriceMinor: 12500, minimumPriceMinor: null });
  assert.deepEqual(bundlePricesForSaving({ sellingPriceMinor: "0", minimumPriceMinor: "0" }), { sellingPriceMinor: 0, minimumPriceMinor: 0 });
});

test("bundle price validation names the appropriate field", () => {
  assert.throws(() => bundlePricesForSaving({ sellingPriceMinor: "" }), /selling price/);
  for (const value of ["-1", "1e3", "1.234", "1,000", "£1", "NaN", "90071992547409.92"]) {
    assert.throws(() => bundlePricesForSaving({ sellingPriceMinor: value }), /Selling price/);
    assert.throws(() => bundlePricesForSaving({ sellingPriceMinor: "125", minimumPriceMinor: value }), /Minimum price/);
  }
  assert.throws(() => bundlePricesForSaving({ sellingPriceMinor: "10", minimumPriceMinor: "10.01" }), /must not exceed selling price/);
});
