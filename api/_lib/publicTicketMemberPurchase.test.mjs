import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicTicketPaymentEvidence, completePublicTicketMembers, recoverPublicTicketMembers } from './publicTicketMemberPurchase.js';
import { literalNormalizedEmailPattern, publicTicketEmailExists } from './publicTicketEmail.js';

const purchase = {
  id: 'purchase', tenant_id: 'tenant', event_id: 'event', event_kind: 'simple',
  booking_ids: ['booking'], snapshot: { booking_items: [{ attendees: [{}] }] },
};
const paid = {
  id: 'pi_test', status: 'succeeded',
  metadata: { public_ticket_purchase_id: purchase.id, tenant_id: 'tenant', event_id: 'event' },
  latest_charge: { paid: true, captured: true, refunded: false, amount_refunded: 0 },
};

test('captured, unrefunded payment must bind purchase, tenant and event', () => {
  assert.doesNotThrow(() => assertPublicTicketPaymentEvidence(paid, purchase, 'tenant', 'event'));
  for (const intent of [
    { ...paid, status: 'requires_capture' }, { ...paid, status: 'canceled' },
    { ...paid, status: 'requires_payment_method' }, { ...paid, latest_charge: 'ch_unexpanded' },
    { ...paid, latest_charge: { ...paid.latest_charge, refunded: true } },
    { ...paid, latest_charge: { ...paid.latest_charge, amount_refunded: 1 } },
    { ...paid, latest_charge: { ...paid.latest_charge, captured: false } },
    { ...paid, metadata: { ...paid.metadata, tenant_id: 'other' } },
    { ...paid, metadata: { ...paid.metadata, event_id: 'other' } },
    { ...paid, metadata: { ...paid.metadata, public_ticket_purchase_id: 'other' } },
  ]) assert.throws(() => assertPublicTicketPaymentEvidence(intent, purchase, 'tenant', 'event'), { code: 'PAYMENT_NOT_ELIGIBLE' });
});

test('unpaid, authorized and empty batches cannot trigger provisioning', async () => {
  const db = { from() { throw new Error('must not write'); }, rpc() { throw new Error('must not provision'); } };
  for (const paymentStatus of ['unpaid', 'authorized', 'failed', 'cancelled', 'public_invoice_po']) {
    assert.equal((await completePublicTicketMembers({ db, purchase, paymentStatus, bookingIds: ['booking'] })).state, 'excluded');
  }
  assert.equal((await completePublicTicketMembers({ db, purchase, paymentStatus: 'paid', bookingIds: [] })).state, 'excluded');
});

function fixture(bookings, rpcResult = { data: { state: 'completed', created: 1 } }) {
  const writes = [];
  let calls = 0;
  return {
    writes, get calls() { return calls; },
    from(table) {
      let update = false;
      const query = {
        select() { return this; }, eq() { return this; }, neq() { return this; }, in() { return this; },
        update(value) { update = true; writes.push({ table, value }); return this; },
        then(resolve) { resolve(update ? { error: null } : { data: bookings, error: null }); },
      };
      return query;
    },
    async rpc(name) { assert.equal(name, 'provision_public_ticket_members'); calls++; return rpcResult; },
  };
}
const booking = { id: 'booking', status: 'confirmed', payment_method: 'free', member_id: null, organization_id: null };

test('free recovery verifies full guest batch; cancelled and partial batches do not create', async () => {
  const free = fixture([booking]);
  assert.equal((await recoverPublicTicketMembers({ db: free, purchase })).state, 'completed');
  assert.equal(free.calls, 1);
  for (const rows of [[], [{ ...booking, status: 'cancelled' }], [{ ...booking, member_id: 'existing' }]]) {
    const db = fixture(rows);
    assert.equal((await recoverPublicTicketMembers({ db, purchase })).state, 'excluded');
    assert.equal(db.calls, 0);
  }
});

test('paid recovery verifies provider; provider failures and mismatched bookings never provision', async () => {
  const receipt = { ...purchase, stripe_payment_intent_id: paid.id };
  const db = fixture([{ ...booking, payment_method: 'card', stripe_payment_intent_id: paid.id }]);
  assert.equal((await recoverPublicTicketMembers({ db, purchase: receipt, loadPaymentIntent: async () => paid })).state, 'completed');
  const failed = fixture([{ ...booking, payment_method: 'card', stripe_payment_intent_id: paid.id }]);
  await assert.rejects(recoverPublicTicketMembers({ db: failed, purchase: receipt, loadPaymentIntent: async () => { throw new Error('Provider unavailable'); } }), /unavailable/);
  assert.equal(failed.calls, 0);
  const wrong = fixture([{ ...booking, payment_method: 'card', stripe_payment_intent_id: 'pi_other' }]);
  await assert.rejects(recoverPublicTicketMembers({ db: wrong, purchase: receipt, loadPaymentIntent: async () => paid }));
  assert.equal(wrong.calls, 0);
});

test('provisioning outage preserves ready evidence and returns a retryable outcome', async () => {
  const db = fixture([booking], { error: { message: 'offline' } });
  const outcome = await completePublicTicketMembers({ db, purchase, tenantId: 'tenant', bookingIds: ['booking'], paymentStatus: 'free' });
  assert.equal(outcome.state, 'retryable');
  assert.equal(db.writes[0].value.state, 'ready');
  assert.equal(db.writes[0].value.completion_evidence.status, 'free');
});

test('literal email query escapes regex metacharacters without treating wildcard email characters as patterns', async () => {
  const pattern = literalNormalizedEmailPattern(' A_*%+Test@Example.com ');
  const regex = new RegExp(pattern.replaceAll('[[:space:]]', '\\s'), 'i');
  assert.equal(regex.test(' a_*%+test@example.com '), true);
  assert.equal(regex.test('a_XX%test@example.com'), false);
  assert.equal(regex.test('prefixa_*%+test@example.com'), false);
  const db = { from() { return { select() { return this; }, eq(key, value) {
    assert.equal(key, 'tenant_id'); assert.equal(value, 'tenant'); return this;
  }, filter(key, op, value) {
    assert.equal(key, 'email'); assert.equal(op, 'imatch'); assert.equal(value, pattern); return this;
  }, async limit() { return { data: [] }; } }; } };
  assert.equal(await publicTicketEmailExists(db, 'tenant', ' A_*%+Test@Example.com '), false);
});
