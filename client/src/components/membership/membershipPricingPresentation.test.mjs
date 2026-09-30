test('API dynamic evidence works without a retained policy snapshot', () => {
  const result = getMembershipPricingPresentation({
    monthly_price: { state: 'calculated', amount: 13, currency: 'GBP', date: '2026-10-01' },
  });
  assert.equal(result.dynamic, true);
  assert.equal(result.monthly.amount, '£13.00');
});
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMembershipMoney,
  getMembershipPricingPresentation,
  isDynamicMembershipPrice,
} from './membershipPricingPresentation.js';

test('recognises dynamic pricing retained in the commitment snapshot', () => {
  const row = {
    commitment_snapshot: {
      collection_policy: { pricing_policy: 'dynamic' },
      amounts: { final_cost: null, total_with_vat: null, currency: 'GBP' },
    },
  };
  assert.equal(isDynamicMembershipPrice(row), true);
  const pricing = getMembershipPricingPresentation(row);
  assert.equal(pricing.agreed.text, 'Uncommitted');
  assert.equal(pricing.net.text, 'Uncommitted');
  assert.equal(pricing.gross.text, 'Uncommitted');
});

test('presents a calculated monthly price as a dated variable estimate', () => {
  const pricing = getMembershipPricingPresentation({
    collectionPolicy: { pricing_policy: 'dynamic' },
    monthly_price: {
      state: 'calculated',
      amount: 12.5,
      currency: 'GBP',
      date: '2027-04-02',
    },
  });
  assert.deepEqual(pricing.monthly, {
    state: 'calculated',
    amount: '£12.50',
    label: 'Variable estimate for 2 Apr 2027 (not confirmed)',
  });
});

test('only labels provider evidence as a scheduled collection', () => {
  const pricing = getMembershipPricingPresentation({
    commitment_snapshot: { collection_policy: { pricing_policy: 'dynamic' } },
    monthly_price: {
      state: 'provider_scheduled',
      amount: 19,
      currency: 'EUR',
      date: '2027-05-06',
    },
  });
  assert.deepEqual(pricing.monthly, {
    state: 'provider_scheduled',
    amount: '€19.00',
    label: 'Scheduled collection for 6 May 2027',
  });
});

test('dynamic unavailable pricing never invents a zero amount', () => {
  const pricing = getMembershipPricingPresentation({
    collection_policy: { pricing_policy: 'dynamic' },
    monthly_price: { state: 'unavailable', amount: null, currency: 'GBP' },
  });
  assert.deepEqual(pricing.monthly, {
    state: 'unavailable',
    amount: null,
    label: 'Variable monthly price unavailable',
  });
});

test('does not treat stale collection details as current monthly evidence', () => {
  const pricing = getMembershipPricingPresentation({
    collectionPolicy: { pricing_policy: 'dynamic' },
    collectionDetails: {
      state: 'reserved',
      pricePreview: {
        amount: 99,
        currency: 'GBP',
        dueDate: '2026-01-01',
      },
    },
  });
  assert.deepEqual(pricing.monthly, {
    state: 'unavailable',
    amount: null,
    label: 'Variable monthly price unavailable',
  });
});

test('persisted ledger totals take priority over differing snapshot quotes', () => {
  const pricing = getMembershipPricingPresentation({
    final_cost: 80,
    total_with_vat: 96,
    vat_amount: 16,
    currency: 'GBP',
    commitment_snapshot: {
      amounts: {
        final_cost: 100,
        total_with_vat: 120,
        currency: 'EUR',
      },
    },
  });
  assert.equal(pricing.currency, 'GBP');
  assert.equal(pricing.agreed.text, '£96.00');
  assert.equal(pricing.net.text, '£80.00');
  assert.equal(pricing.gross.text, '£96.00');
  assert.equal(pricing.vat.text, '£16.00');
});

test('preserves valid zero and historical fixed totals', () => {
  assert.equal(formatMembershipMoney(0, 'GBP'), '£0.00');
  const pricing = getMembershipPricingPresentation({
    final_cost: 0,
    vat_amount: 0,
    total_with_vat: 0,
    currency: 'GBP',
  });
  assert.equal(pricing.agreed.text, '£0.00');
  assert.equal(pricing.net.text, '£0.00');
  assert.equal(pricing.gross.text, '£0.00');
  assert.equal(pricing.monthly, null);
});

test('presents a nullable legacy upfront invoice amount without pricing simulation', () => {
  const fromGross = getMembershipPricingPresentation({
    final_cost: null,
    total_with_vat: 125,
    currency: 'GBP',
    config_id: null,
    commitment_snapshot: null,
  });
  assert.equal(fromGross.agreed.text, '£125.00');
  assert.equal(fromGross.gross.text, '£125.00');
  assert.equal(fromGross.net.text, 'Uncommitted');
  assert.equal(fromGross.monthly, null);

  const absent = getMembershipPricingPresentation({
    final_cost: null,
    total_with_vat: null,
    currency: 'GBP',
  });
  assert.equal(absent.agreed.text, 'Uncommitted');
  assert.equal(absent.gross.text, 'Uncommitted');
});
