import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeSuccessfulPaymentTime, finalizePostGraceStripePayment } from './postGraceStripeFinalization.js';

test('commencement comes from the succeeded event, not checkout creation before midnight', async () => {
  const created = Date.parse('2026-11-03T23:59:00Z') / 1000;
  const paid = Date.parse('2026-11-04T00:01:00Z') / 1000;
  const stripe = { events: { list: async args => {
    assert.equal(args.type, 'payment_intent.succeeded');
    assert.deepEqual(args.created, { gte: created });
    return { has_more: false, data: [
      { type: 'payment_intent.succeeded', created, data: { object: { id: 'another', status: 'succeeded' } } },
      { type: 'payment_intent.succeeded', created: paid, data: { object: { id: 'pi-test', status: 'succeeded' } } },
    ] };
  } } };
  assert.equal(await stripeSuccessfulPaymentTime(stripe, { id: 'pi-test', status: 'succeeded', created }),
    '2026-11-04T00:01:00.000Z');
});
test('payment evidence pages without inventing a time when Stripe has not published the event', async () => {
  const calls = [];
  const stripe = { events: { list: async args => {
    calls.push(args);
    return calls.length === 1 ? { has_more: true, data: [{ id: 'evt-first' }] }
      : { has_more: false, data: [] };
  } } };
  await assert.rejects(stripeSuccessfulPaymentTime(stripe, { id: 'pi-test', status: 'succeeded', created: 1 }),
    /Do not pay again/);
  assert.equal(calls[1].starting_after, 'evt-first');
});
test('ordinary payment does not perform additional database or provider calls', async () => {
  const result = await finalizePostGraceStripePayment(null, { tenantId: 'tenant',
    paymentIntent: { id: 'pi-ordinary', metadata: {} } });
  assert.deepEqual(result, { applicable: false });
});
test('wrong owner and incomplete settlement fail before any database call', async () => {
  await assert.rejects(finalizePostGraceStripePayment(null, { tenantId: 'tenant',
    paymentIntent: { id: 'pi-test', status: 'succeeded', amount: 7100, amount_received: 7000,
      metadata: { post_grace_election_id: 'election', tenant_id: 'tenant', member_id: 'member' } } }),
  /settlement is invalid/);
});
