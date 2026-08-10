import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNewApplicantCost, quoteFromSimulationResult } from './membershipQuote.js';

// A calendar year window (365 days, non-leap).
const year = {
  label: '2026/2027',
  start: new Date(2026, 0, 1),
  end: new Date(2026, 11, 31),
};

test('no pro-rata, no incentive: full annual cost', () => {
  const r = computeNewApplicantCost({ config: {}, annualCost: 1000, membershipYear: year, joinDate: new Date(2026, 5, 1) });
  assert.equal(r.finalCost, 1000);
  assert.equal(r.proRataEnabled, false);
  assert.equal(r.freeDiscount, 0);
});

test('pro-rata from join date (mirrors simulation year-1 math)', () => {
  const join = new Date(2026, 6, 1); // 1 July 2026 → 184 days remain
  const r = computeNewApplicantCost({ config: { prorata_enabled: true }, annualCost: 365, membershipYear: year, joinDate: join });
  assert.equal(r.proRataEnabled, true);
  assert.equal(r.prorataDays, 184);
  assert.equal(r.dailyCost, 1); // 365/365
  assert.equal(r.prorataCost, 184);
  assert.equal(r.finalCost, 184);
});

test('pro-rata with free months reduces billable days', () => {
  const join = new Date(2026, 6, 1);
  const config = { prorata_enabled: true, free_period_amount: 1, free_period_unit: 'months' };
  const r = computeNewApplicantCost({ config, annualCost: 365, membershipYear: year, joinDate: join });
  const freeDays = Math.round(1 * 30.44); // 30
  assert.equal(r.freePeriodDaysApplied, freeDays);
  assert.equal(r.billableDays, 184 - freeDays);
  assert.equal(r.finalCost, 184 - freeDays);
});

test('percent incentive with pro-rata is proportional', () => {
  const join = new Date(2026, 0, 1); // full year
  const config = { prorata_enabled: true, free_period_amount: 10, free_period_unit: 'percent' };
  const r = computeNewApplicantCost({ config, annualCost: 1000, membershipYear: year, joinDate: join });
  // Full-year join → full 10% discount
  assert.equal(r.prorataDays, 365);
  assert.equal(r.freeDiscount, 100);
  assert.equal(r.finalCost, r.prorataCost - 100);
});

test('percent incentive without pro-rata applies to annual cost', () => {
  const config = { free_period_amount: 25, free_period_unit: 'percent' };
  const r = computeNewApplicantCost({ config, annualCost: 400, membershipYear: year, joinDate: new Date(2026, 3, 1) });
  assert.equal(r.freeDiscount, 100);
  assert.equal(r.finalCost, 300);
});

test('free period without pro-rata discounts free days from annual cost', () => {
  const config = { free_period_amount: 2, free_period_unit: 'months' };
  const r = computeNewApplicantCost({ config, annualCost: 365, membershipYear: year, joinDate: new Date(2026, 3, 1) });
  const freeDays = Math.min(Math.round(2 * 30.44), 365); // 61
  assert.equal(r.freePeriodDaysApplied, freeDays);
  assert.equal(r.finalCost, parseFloat((365 - 1 * freeDays).toFixed(2)));
});

test('final cost never goes below zero', () => {
  const config = { free_period_amount: 200, free_period_unit: 'percent' };
  const r = computeNewApplicantCost({ config, annualCost: 100, membershipYear: year, joinDate: new Date(2026, 0, 1) });
  assert.equal(r.finalCost, 0);
});

test('quoteFromSimulationResult adapts a simulation result to the quote shape', () => {
  const quote = quoteFromSimulationResult({
    config: { id: 'cfg1', name: 'Standard', invoice_description: 'Membership {year}' },
    matchedBand: { id: 'band1' },
    tierLabel: 'Tier A',
    fieldValue: 42,
    annualCost: 900,
    annualCostBeforeDiscounts: 1000,
    customDiscountTotal: 100,
    customDiscountDetails: [{ rule_id: 'd1' }],
    finalCost: 850,
    currency: 'GBP',
    membershipYear: { label: '2026/2027' },
    yearNumber: 1,
    prorataCost: 850,
    prorataDays: 300,
    freeDiscount: 0,
    freePeriodDaysApplied: 0,
    billingPeriod: 'annual',
    vatRatePercent: 20,
    vatAmount: 170,
    totalWithVat: 1020,
    taxType: 'OUTPUT2',
    taxLabel: '20% (VAT on Income)',
    nominalCode: '200',
  }, 'organization');
  assert.equal(quote.target, 'organization');
  assert.equal(quote.config_id, 'cfg1');
  assert.equal(quote.membership_year, '2026/2027');
  assert.equal(quote.final_cost, 850);
  assert.equal(quote.total_with_vat, 1020);
  assert.equal(quote.tax_type, 'OUTPUT2');
  assert.equal(quote.nominal_code, '200');
  assert.equal(quote.invoice_description, 'Membership {year}');
});
