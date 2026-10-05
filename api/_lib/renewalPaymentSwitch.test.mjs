import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelRenewalIntents, cancelRenewalSetup, changeRenewalPaymentMethod } from './renewalPaymentSwitch.js';

const electionId = '10000000-0000-4000-8000-000000000001';
const quote = {
  id: 'quote', tenant_id: 'tenant', member_id: 'payer', organization_id: null,
  stripe_payment_intent_id: 'pi_original',
  quote: { stripeEnvironment: 'test', stripeAccountId: 'acct_saved' },
};
function provider(states = {}) {
  const calls = [];
  const intents = new Map(['pi_original', 'pi_replacement'].map((id, index) => [id, {
    id, status: states[id] || 'requires_payment_method', livemode: false,
    metadata: { tenant_id: 'tenant', member_id: 'payer', membership_quote_id: 'quote',
      ...(index ? { membership_attempt_id: 'attempt' } : {}) },
  }]));
  const stripe = {
    accounts: { retrieve: async () => ({ id: 'acct_saved' }) },
    paymentIntents: {
      retrieve: async id => { calls.push(['retrieve', id]); return intents.get(id); },
      cancel: async id => {
        calls.push(['cancel', id]);
        intents.set(id, { ...intents.get(id), status: 'canceled' });
        return intents.get(id);
      },
    },
  };
  return { stripe, calls, intents };
}
const attempts = [{ id: 'attempt', provider_intent_id: 'pi_replacement' }];

test('cancels and re-reads original and replacement in the saved provider context', async () => {
  const p = provider();
  const receipts = await cancelRenewalIntents({ quote, attempts,
    stripeForQuote: async saved => { assert.equal(saved, quote); return p.stripe; } });
  assert.deepEqual(receipts.map(r => r.id), ['pi_original', 'pi_replacement']);
  assert.equal(receipts.every(r => r.status === 'canceled'), true);
  assert.equal(p.calls.filter(([action]) => action === 'cancel').length, 2);
  assert.equal(p.calls.filter(([action]) => action === 'retrieve').length, 4);
});
for (const status of ['processing', 'succeeded', 'requires_capture', 'unknown']) {
  test(`retains the election and cancels nothing when any intent is ${status}`, async () => {
    const p = provider({ pi_replacement: status });
    await assert.rejects(cancelRenewalIntents({ quote, attempts, stripeForQuote: async () => p.stripe }),
      { code: 'payment_committed' });
    assert.equal(p.calls.some(([action]) => action === 'cancel'), false);
  });
}
test('wrong owner, environment, account and attempt metadata fail closed', async () => {
  for (const alter of [
    p => { p.intents.get('pi_original').metadata.member_id = 'other'; },
    p => { p.intents.get('pi_original').livemode = true; },
    p => { p.stripe.accounts.retrieve = async () => ({ id: 'acct_other' }); },
    p => { p.intents.get('pi_replacement').metadata.membership_attempt_id = 'other'; },
  ]) {
    const p = provider();
    alter(p);
    await assert.rejects(cancelRenewalIntents({ quote, attempts, stripeForQuote: async () => p.stripe }));
    assert.equal(p.calls.some(([action]) => action === 'cancel'), false);
  }
});
test('an unbound replacement or a cancellation race cannot produce release evidence', async () => {
  const p = provider();
  await assert.rejects(cancelRenewalIntents({ quote, attempts: [{ id: 'attempt' }],
    stripeForQuote: async () => p.stripe }), { code: 'provider_outcome_unknown' });
  p.stripe.paymentIntents.cancel = async () => { throw new Error('already processing'); };
  await assert.rejects(cancelRenewalIntents({ quote, attempts, stripeForQuote: async () => p.stripe }));
});
function database(snapshot) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: name === 'begin_membership_successor_switch' ? snapshot : true };
    },
  };
}
test('transport failure retains the durable reconciliation fence; retry reconciles cancellation', async () => {
  const db = database({ quote, attempts });
  const p = provider();
  p.stripe.paymentIntents.cancel = async () => { throw new Error('timeout'); };
  const request = { db, tenantId: 'tenant', memberId: 'payer', electionId,
    stripeForQuote: async () => p.stripe };
  await assert.rejects(changeRenewalPaymentMethod(request), { code: 'provider_unavailable', status: 503 });
  assert.deepEqual(db.calls.map(c => c.name), ['begin_membership_successor_switch']);
  const retry = provider({ pi_original: 'canceled', pi_replacement: 'canceled' });
  assert.deepEqual(await changeRenewalPaymentMethod({ ...request, stripeForQuote: async () => retry.stripe }),
    { released: true });
  assert.equal(retry.calls.some(([action]) => action === 'cancel'), false);
});
test('committed payment restores normal callback reconciliation, not method choice', async () => {
  const db = database({ quote, attempts });
  const p = provider({ pi_original: 'succeeded' });
  await assert.rejects(changeRenewalPaymentMethod({
    db, tenantId: 'tenant', memberId: 'payer', electionId, stripeForQuote: async () => p.stripe,
  }), { code: 'payment_committed' });
  assert.deepEqual(db.calls.map(c => c.name),
    ['begin_membership_successor_switch', 'refuse_membership_successor_switch']);
});
test('stale request has an explicit election identity and completed replay has no provider effects', async () => {
  const db = database({ released: true });
  await assert.rejects(changeRenewalPaymentMethod({ db, memberId: 'payer' }), { code: 'renewal_changed' });
  assert.equal(db.calls.length, 0);
  assert.deepEqual(await changeRenewalPaymentMethod({ db, tenantId: 'tenant', memberId: 'payer', electionId }),
    { released: true });
  assert.equal(db.calls[0].args.p_election_id, electionId);
});

test('open monthly-card setup is expired and re-read; completed subscription is retained', async () => {
  const agreement = { provider: 'stripe', tenant_id: 'tenant', member_id: 'payer',
    status: 'payment_setup_required', environment: 'test', stripe_checkout_session_id: 'cs_saved' };
  let session = { id: 'cs_saved', status: 'open', livemode: false,
    metadata: { tenant_id: 'tenant', member_id: 'payer' } };
  let expired = 0;
  const stripeForAgreement = async () => ({ checkout: { sessions: {
    retrieve: async () => session,
    expire: async () => { expired++; session = { ...session, status: 'expired' }; },
  } } });
  assert.equal((await cancelRenewalSetup({ agreement, stripeForAgreement })).status, 'canceled');
  assert.equal(expired, 1);
  session = { ...session, status: 'complete', subscription: 'sub_committed' };
  await assert.rejects(cancelRenewalSetup({ agreement, stripeForAgreement }), { code: 'payment_committed' });
  assert.equal(expired, 1);
});

test('unfulfilled DD request can cancel, but any mandate/payment linkage refuses', async () => {
  const agreement = { provider: 'gocardless', tenant_id: 'tenant', member_id: 'payer',
    status: 'payment_setup_required', environment: 'sandbox', gocardless_billing_request_id: 'BR_saved' };
  let request = { id: 'BR_saved', status: 'pending',
    metadata: { tenant_id: 'tenant', member_id: 'payer' }, links: {} };
  let cancelled = 0;
  const gcForAgreement = async () => ({
    getBillingRequest: async () => request,
    cancelBillingRequest: async () => { cancelled++; request = { ...request, status: 'cancelled' }; },
  });
  assert.equal((await cancelRenewalSetup({ agreement, gcForAgreement })).status, 'canceled');
  assert.equal(cancelled, 1);
  for (const links of [{ mandate_request_mandate: 'MD_committed' }, { payment_request_payment: 'PM_committed' }]) {
    request = { ...request, status: 'ready_to_fulfil', links };
    await assert.rejects(cancelRenewalSetup({ agreement, gcForAgreement }), { code: 'payment_committed' });
  }
  assert.equal(cancelled, 1);
});
