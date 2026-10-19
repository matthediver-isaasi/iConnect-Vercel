import test from "node:test";
import assert from "node:assert/strict";
import { persistedLineAmounts, persistedQuoteAmounts } from "./quoteDisplayAmounts.js";

test("snapshot amounts are authoritative even when the stored rate and price disagree", () => {
  const line = { quantity: "2.5", quoted_unit_price_minor: 1235, discount_bps: 1250,
    tax_rate_bps: 2000, net_minor: 2701, tax_minor: 539, gross_minor: 3240 };
  assert.deepEqual(persistedLineAmounts(line), { net: 2701, tax: 539, gross: 3240 });
  assert.deepEqual(persistedQuoteAmounts({
    totals: { netMinor: 9876, taxMinor: 321, grossMinor: 10197 },
    net_minor: 1, tax_minor: 2, gross_minor: 3, lines: [line],
  }), { net: 9876, tax: 321, gross: 10197 });
});

test("complete saved lines supply missing totals, preserving zero VAT and aliases", () => {
  assert.deepEqual(persistedQuoteAmounts({ lines: [
    { netMinor: 1200, taxMinor: 240, grossMinor: 1440 },
    { net_minor: "813", tax_minor: "0", gross_minor: "813" },
    { netTotalMinor: 199, taxTotalMinor: 0, totalMinor: 199 },
  ] }), { net: 2212, tax: 240, gross: 2452 });
  assert.deepEqual(persistedQuoteAmounts({ totals: { netMinor: 0, taxMinor: 0, grossMinor: 0 } }),
    { net: 0, tax: 0, gross: 0 });
});

test("legacy missing amounts stay unknown rather than being repriced or presented as zero", () => {
  assert.deepEqual(persistedLineAmounts({ quantity: "3", quotedUnitPriceMinor: 1000, taxRateBps: 2000, totalMinor: 3600 }),
    { net: null, tax: null, gross: 3600 });
  assert.deepEqual(persistedQuoteAmounts({ lines: [{ gross_minor: 3600 }] }),
    { net: null, tax: null, gross: 3600 });
  assert.deepEqual(persistedQuoteAmounts({}), { net: null, tax: null, gross: null });
});
