import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shapePersistedCommitment,
  shapePersistedCommitments,
} from './member-membership.js';

test('shapes an immutable rolling commitment without live pricing substitution', () => {
  const commitment = shapePersistedCommitment({
    id: 'term-1',
    membership_source: 'personal',
    term_key: 'rolling:2026-09-15',
    term_start_date: '2026-09-15',
    term_end_date: '2027-09-14',
    membership_renewal_date: '2027-09-15',
    term_duration_months: 12,
    config_id: 'config-20',
    tier_label: 'Professional',
    final_cost: 240,
    total_with_vat: 288,
    currency: 'GBP',
    payment_method: 'stripe_monthly_card',
    payment_frequency: 'monthly',
    commitment_snapshot: {
      version: 1,
      start_mode: 'immediate',
      billing_period: 'annual',
      config: { id: 'config-20', name: '2026 Professional' },
      amounts: { final_cost: 240, total_with_vat: 288, monthly_amount: 24, currency: 'GBP' },
    },
  }, new Date('2027-01-01T00:00:00Z'));

  assert.equal(commitment.lifecycle, 'current');
  assert.equal(commitment.structureName, '2026 Professional');
  assert.equal(commitment.agreedPrice, 288);
  assert.equal(commitment.monthlyAmount, 24);
  assert.equal(commitment.billingPeriod, 'annual');
  assert.equal(commitment.paymentFrequency, 'monthly');
  assert.equal(commitment.renewalDate, '2027-09-15');
});

test('distinguishes scheduled terms and ignores ambiguous legacy rows', () => {
  const commitments = shapePersistedCommitments([{
    id: 'legacy',
    membership_year: '2025/2026',
    final_cost: 100,
  }, {
    id: 'scheduled',
    term_key: 'rolling:2027-09-15',
    term_start_date: '2027-09-15',
    term_end_date: '2028-09-14',
    membership_renewal_date: '2028-09-15',
    term_duration_months: 12,
    status: 'scheduled',
  }], new Date('2027-01-01T00:00:00Z'));

  assert.equal(commitments.length, 1);
  assert.equal(commitments[0].id, 'scheduled');
  assert.equal(commitments[0].lifecycle, 'scheduled');
});