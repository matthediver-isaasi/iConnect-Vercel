import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePortalUpfrontPayment } from './member-fees.js';
import {
  snapshotFormMembershipPayment, saveFormMembershipPaymentQuote,
  createReservedFormMembershipIntent, loadFormMembershipPaymentQuote,
} from '../_lib/formMembershipPaymentQuote.js';
import { recordSucceededMembershipPaymentIntent } from '../_lib/membershipPaymentReconciliation.js';

test('portal callbacks discard supplied identity/year and use saved original owner', async () => {
  const request = {
    method: 'POST', headers: { host: 'tenant.example' },
    body: { action: 'confirm_payment', memberId: 'spoof', organizationId: 'new-org', membershipYear: '2099', paymentIntentId: 'pi_original' },
  };
  const currentMember = { id: 'payer', organization_id: 'new-org' };
  const quote = {
    simResult: { membershipYear: { label: 'rolling:2026-09-15' } },
  };
  const db = { from() { return {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { id: 'q1', member_id: 'payer', organization_id: 'original-org', quote, stripe_payment_intent_id: 'pi_original' } }; },
  }; } };
  let calls = 0;
  const delegate = async (req) => {
    calls += 1;
    assert.equal(req.headers.host, 'tenant.example');
    assert.equal(req.body.memberId, 'payer');
    assert.equal(req.body.membershipYear, undefined);
    assert.equal(req.body.organizationId, undefined);
    assert.equal(req.membershipPaymentContext.targetYear, null);
    return loadFormMembershipPaymentQuote(db, {
      id: req.body.paymentIntentId,
      metadata: { tenant_id: 'tenant', member_id: req.body.memberId, organization_id: 'original-org', membership_quote_id: 'q1', membership_year: 'rolling:2026-09-15' },
    });
  };
  const first = await handlePortalUpfrontPayment(request, {}, currentMember, delegate);
  const retry = await handlePortalUpfrontPayment(request, {}, currentMember, delegate);
  assert.equal(calls, 2);
  assert.equal(first.organizationId, 'original-org');
  assert.deepEqual(retry, first);
});

test('concurrent portal preparation uses the shared owner reservation and identical Stripe intent', async () => {
  let stored;
  let creates = 0;
  const providerIntents = new Map();
  const db = { async rpc(name, params) {
    if (name === 'reserve_form_membership_payment_quote') {
      stored ||= { id: 'q_shared', tenant_id: params.p_tenant_id, quote: params.p_quote, created_at: '2026-09-15T00:00:00Z' };
      return { data: stored };
    }
    assert.equal(name, 'bind_form_membership_payment_quote');
    return { data: true };
  } };
  const stripe = { paymentIntents: { async create(params, { idempotencyKey }) {
    if (!providerIntents.has(idempotencyKey)) {
      creates += 1;
      providerIntents.set(idempotencyKey, { id: 'pi_one', amount: params.amount });
    }
    return providerIntents.get(idempotencyKey);
  } } };
  const delegate = async (req) => {
    assert.equal(req.membershipPaymentContext.source, 'member-portal');
    const snapshot = snapshotFormMembershipPayment({
      config: { id: 'cfg', start_mode: 'immediate', billing_period: 'quarterly', currency: 'GBP' },
      membershipYear: { label: 'rolling:2026-09-15', start: '2026-09-15' },
      annualCost: 60, finalCost: 60, vatAmount: 0, totalWithVat: 60, currency: 'GBP',
    });
    snapshot.paymentIntentParams = { amount: 6000, currency: 'gbp', metadata: { member_id: req.body.memberId } };
    const reservation = await saveFormMembershipPaymentQuote(db, { tenantId: 'tenant', memberId: req.body.memberId, snapshot });
    return createReservedFormMembershipIntent(db, stripe, reservation, '2026-09-15');
  };
  const request = { method: 'POST', body: { action: 'create_payment', membershipYear: 'rolling:2026-09-15' } };
  const result = await Promise.all([1, 2].map(() => handlePortalUpfrontPayment(request, {}, { id: 'member' }, delegate)));
  assert.equal(result[0].id, result[1].id);
  assert.equal(creates, 1);
  assert.equal(stored.quote.simResult.commitment.membership_renewal_date, '2026-12-15');
});

for (const source of ['form-membership-payment', 'member-portal']) {
  test(`ambiguous legacy ${source} recovery cannot invent a paid term`, async () => {
    const db = { from(table) { return {
      select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: table === 'member' ? { id: 'member' } : null }; },
      insert() { assert.fail('Legacy recovery must not insert history'); },
      update() { assert.fail('Legacy recovery must not mutate records'); },
    }; } };
    const result = await recordSucceededMembershipPaymentIntent({
      tenantId: 'tenant',
      paymentIntent: { id: 'pi_old', status: 'succeeded', amount: 24000, currency: 'gbp',
        metadata: { tenant_id: 'tenant', member_id: 'member', membership_year: '2026/2027', source } },
    }, { db, fireWorkflow() { assert.fail('No speculative membership workflow'); } });
    assert.equal(result.status, 'unmatched');
    assert.match(result.detail, /administrator review/);
  });
}