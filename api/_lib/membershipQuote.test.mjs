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

test('member quote exposes the flat monthly-card offer from the resolved structure', () => {
  const quote = quoteFromSimulationResult({
    success: true,
    config: {
      id: 'cfg-flat',
      name: 'Individual',
      pricing_model: 'flat',
      card_monthly_enabled: true,
      dd_monthly_amount: 25,
      dd_instalment_count: 10,
      currency: 'GBP',
    },
    matchedBand: null,
    annualCost: 250,
    finalCost: 250,
    currency: 'GBP',
    membershipYear: { label: '2026/2027', start: new Date('2026-01-01T00:00:00Z') },
  }, 'member');

  assert.deepEqual(quote.monthly_card_offer, {
    monthlyAmount: 25,
    monthlyAmountMinor: 2500,
    instalmentCount: 10,
    planTotal: 250,
    currency: 'GBP',
    activationRule: 'first_payment',
    graceDays: 7,
    termsVersion: 'v1',
    invoicingMode: 'annual',
  });
  assert.equal(quote.membership_year_start, '2026-01-01');
});

test('member quote uses the resolved pricing band monthly amount', () => {
  const quote = quoteFromSimulationResult({
    success: true,
    config: {
      id: 'cfg-tiered',
      pricing_model: 'tiered',
      card_monthly_enabled: true,
      dd_monthly_amount: 999,
      dd_instalment_count: 12,
    },
    matchedBand: { id: 'band-2', dd_monthly_amount: 17.5 },
    annualCost: 200,
    finalCost: 200,
    currency: 'GBP',
    membershipYear: { label: '2026/2027' },
  }, 'member');

  assert.equal(quote.monthly_card_offer.monthlyAmount, 17.5);
  assert.equal(quote.monthly_card_offer.planTotal, 210);
  assert.equal(quote.band_id, 'band-2');
});

test('monthly-card offer is omitted when disabled and for organisation quotes', () => {
  const enabled = {
    success: true,
    config: {
      id: 'cfg',
      pricing_model: 'flat',
      card_monthly_enabled: true,
      dd_monthly_amount: 20,
    },
    annualCost: 240,
    finalCost: 240,
    currency: 'GBP',
    membershipYear: { label: '2026/2027' },
  };
  assert.equal(quoteFromSimulationResult(enabled, 'organization').monthly_card_offer, undefined);
  assert.equal(quoteFromSimulationResult({
    ...enabled,
    config: { ...enabled.config, card_monthly_enabled: false },
  }, 'member').monthly_card_offer, undefined);
});
