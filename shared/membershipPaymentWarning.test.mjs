import test from 'node:test';
import assert from 'node:assert/strict';
import { membershipPaymentWarning } from './membershipPaymentWarning.js';

const now = new Date('2026-11-24T12:00:00Z');
test('cancelled failed collection after grace warns without inventing entitlement', () => {
  const result = membershipPaymentWarning({
    agreement: { status: 'payment_plan_cancelled' },
    plan: { last_payment_status: 'failed', grace_expires_at: '2026-11-07T07:01:53Z' }, now,
  });
  assert.equal(result.code, 'cancelled_after_grace');
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message']);
});
test('cancelled paid arrangement never claims unresolved expired grace', () => {
  assert.equal(membershipPaymentWarning({
    plan: { status: 'payment_plan_cancelled', last_payment_status: 'paid_out',
      grace_expires_at: '2026-11-07T07:01:53Z' }, now,
  }).code, 'cancelled');
});
test('grace boundary is exact and invalid dates cannot prove expiry', () => {
  for (const grace of ['2026-11-24T12:00:01Z', 'invalid', null]) {
    assert.equal(membershipPaymentWarning({
      plan: { status: 'payment_plan_cancelled', last_payment_status: 'failed', grace_expires_at: grace }, now,
    }).code, 'cancelled');
  }
  assert.equal(membershipPaymentWarning({
    plan: { status: 'payment_plan_cancelled', last_payment_status: 'failed', grace_expires_at: now.toISOString() }, now,
  }).code, 'cancelled_after_grace');
});
test('active failed plan warns and successful or absent evidence does not', () => {
  assert.equal(membershipPaymentWarning({ plan: { status: 'active', last_payment_status: 'failed' }, now }).code, 'failed');
  assert.equal(membershipPaymentWarning({ plan: { status: 'active', last_payment_status: 'paid_out' }, now }), null);
  assert.equal(membershipPaymentWarning({ now }), null);
});
test('Stripe-cancelled monthly card plan gets card copy, never Direct Debit copy or debt clearance', () => {
  // Stripe ending the subscription leaves the card agreement's own status.
  const result = membershipPaymentWarning({
    agreement: { provider: 'stripe', status: 'active' },
    plan: { provider: 'stripe', status: 'payment_plan_cancelled', last_payment_status: 'paid' }, now,
  });
  assert.equal(result.code, 'card_plan_cancelled');
  assert.match(result.message, /monthly card payment plan has been cancelled/);
  assert.doesNotMatch(result.message, /Direct Debit|cleared|nothing (more )?(is )?owed|no longer owe/i);
  const late = membershipPaymentWarning({
    agreement: { provider: 'stripe', status: 'active' },
    plan: { provider: 'stripe', status: 'payment_plan_cancelled', last_payment_status: 'failed',
      grace_expires_at: '2026-11-07T07:01:53Z' }, now,
  });
  assert.equal(late.code, 'card_plan_cancelled_after_grace');
  assert.match(late.message, /needs attention/);
  assert.doesNotMatch(late.message, /Direct Debit/);
  assert.equal(membershipPaymentWarning({
    agreement: { provider: 'gocardless', status: 'payment_plan_cancelled' },
    plan: { provider: 'gocardless', status: 'payment_plan_cancelled' }, now,
  }).code, 'cancelled');
  assert.equal(membershipPaymentWarning({
    agreement: { provider: 'stripe', status: 'active' },
    plan: { provider: 'stripe', status: 'active', last_payment_status: 'paid' }, now,
  }), null);
});
