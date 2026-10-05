import test from 'node:test';
import assert from 'node:assert/strict';
import { compensatePublicTicketCapacity } from './publicTicketMemberRecovery.js';

test('capacity refund retries after interruption without a second refund; no booking/member writes', async () => {
  const purchase = { id: 'purchase', tenant_id: 'tenant', event_id: 'event', stripe_payment_intent_id: 'pi_fixture' };
  const intent = { id: 'pi_fixture', status: 'succeeded',
    metadata: { public_ticket_purchase_id: 'purchase', tenant_id: 'tenant', event_id: 'event' },
    latest_charge: { paid: true, captured: true, refunded: false, amount_refunded: 0 } };
  let refundCalls = 0, failedFinalWrite = false;
  const writes = [];
  const db = { from(table) {
    assert.equal(table, 'public_ticket_member_purchase');
    let value;
    return { update(body) { value = body; writes.push(body); return this; }, eq() { return this; },
      then(resolve) {
        if (value.state === 'excluded' && !failedFinalWrite) {
          failedFinalWrite = true; resolve({ error: { message: 'Interrupted final write' } });
        } else resolve({ error: null });
      } };
  } };
  const stripe = {
    paymentIntents: { retrieve: async () => intent },
    refunds: { create: async (body, options) => {
      refundCalls++;
      assert.equal(body.payment_intent, intent.id);
      assert.equal(options.idempotencyKey, 'public-ticket-capacity:purchase');
      intent.latest_charge.refunded = true;
      return { status: 'succeeded' };
    } },
  };
  assert.equal((await compensatePublicTicketCapacity(db, purchase, stripe)).state, 'retryable');
  assert.equal((await compensatePublicTicketCapacity(db, purchase, stripe)).refunded, true);
  assert.equal(refundCalls, 1);
  assert.equal(writes.at(-1).last_error_code, 'capacity_refunded');
  intent.metadata.tenant_id = 'other';
  assert.equal((await compensatePublicTicketCapacity(db, purchase, stripe)).state, 'retryable');
  assert.equal(refundCalls, 1);
});
