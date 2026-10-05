import test from 'node:test';
import assert from 'node:assert/strict';
import { deferredCardTerms, deferredCardCheckoutOptions, isZeroValueCardSetupInvoice } from './stripeDeferredCardTerms.js';
import { classifyMembershipReturn } from '../../client/src/lib/membershipPaymentReturn.js';

const simulation = {
  paymentSchedule: { term_start_date: '2026-10-10', term_end_date: '2027-10-09' },
};

test('reported expiry 09/10/2026: successor authorizes early without a charge or changed dates', () => {
  const before = structuredClone(simulation);
  const terms = deferredCardTerms(simulation, '2026-10-05T12:00:00Z');
  assert.equal(terms.first_charge_date, '2026-10-10');
  assert.equal(terms.term_end_date, '2027-10-09');
  assert.equal(terms.subscription_data.trial_end, Date.parse('2026-10-10') / 1000);
  assert.deepEqual(deferredCardCheckoutOptions({ deferred_billing: terms }), {
    payment_method_collection: 'always', payment_method_types: ['card'], subscription_data: terms.subscription_data,
  });
  assert.deepEqual(simulation, before);
});

for (const now of ['2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z', '2026-10-09T23:59:00Z']) {
  test(`short lead ${now} uses a fixed anchor and no prorations, never an immediate charge`, () => {
    const terms = deferredCardTerms(simulation, now);
    assert.deepEqual(terms.subscription_data, {
      billing_cycle_anchor: Date.parse('2026-10-10') / 1000, proration_behavior: 'none',
    });
  });
}

for (const now of ['2026-10-10T00:00:00Z', '2026-10-15T12:00:00Z']) {
  test(`day-of/late ${now} retains the existing immediate-collection policy`, () => {
    assert.equal(deferredCardTerms(simulation, now), null);
  });
}

for (const start of ['2027-01-31', '2028-02-29', '2027-04-30']) {
  test(`month-end first charge authority is not shifted: ${start}`, () => {
    const terms = deferredCardTerms({ paymentSchedule: { term_start_date: start } }, '2026-10-05');
    assert.equal(new Date(terms.first_charge_at * 1000).toISOString().slice(0, 10), start);
  });
}

test('zero setup is not settlement; missing invoice economics do not masquerade as zero', () => {
  assert.equal(isZeroValueCardSetupInvoice({ amount_paid: 0, amount_due: 0, total: 0 }), true);
  assert.equal(isZeroValueCardSetupInvoice({ amount_paid: 0 }), false);
  assert.equal(isZeroValueCardSetupInvoice({ amount_paid: 1000, amount_due: 1000, total: 1000 }), false);
});

test('scheduled display requires confirmed server state, not a successful return URL', () => {
  const input = { provider: 'monthly-card', outcome: 'complete' };
  assert.equal(classifyMembershipReturn({ ...input, agreement: { status: 'first_payment_pending', scheduled: true } }), 'scheduled');
  assert.equal(classifyMembershipReturn({ ...input, agreement: { status: 'payment_setup_required', scheduled: true } }), 'verification_pending');
  assert.equal(classifyMembershipReturn({ ...input, agreement: { status: 'payment_grace_period', scheduled: true } }), 'payment_attention');
});
