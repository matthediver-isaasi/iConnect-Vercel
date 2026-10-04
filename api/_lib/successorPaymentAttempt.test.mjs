import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeSuccessorPaymentAttempt } from './successorPaymentAttempt.js';

function fixture({ bindFails = false, createdAt = '2026-11-01T00:00:00Z' } = {}) {
  let attempt, creates = 0;
  const intents = new Map();
  const db = {
    from() { return { select() { return this; }, eq() { return this; }, order() { return this; },
      async limit() { return { data: attempt ? [structuredClone(attempt)] : [] }; } }; },
    async rpc(name, args) {
      if (name === 'reserve_successor_payment_attempt') {
        attempt ||= { id: 'attempt', quote_id: 'quote', created_at: createdAt };
        return { data: structuredClone(attempt) };
      }
      assert.equal(name, 'bind_successor_payment_attempt');
      if (bindFails) return { error: { message: 'local failure' } };
      attempt.provider_intent_id = args.p_intent_id;
      return { data: true };
    },
  };
  const stripe = { paymentIntents: {
    async create(params, options) {
      assert.equal(params.amount, 12000);
      assert.equal(params.metadata.membership_attempt_id, 'attempt');
      assert.equal(options.idempotencyKey, 'membership-attempt:attempt');
      if (!intents.has(options.idempotencyKey)) {
        creates++;
        intents.set(options.idempotencyKey, { id: 'pi_replacement', status: 'requires_payment_method', ...params });
      }
      return intents.get(options.idempotencyKey);
    },
    async retrieve(id) {
      assert.equal(id, 'pi_replacement');
      return intents.get('membership-attempt:attempt');
    },
  } };
  return { db, stripe, reservation: { id: 'quote', tenant_id: 'tenant',
    quote: { paymentIntentParams: { amount: 12000, currency: 'gbp', metadata: {} } } },
  cancelled: { id: 'pi_cancelled', status: 'canceled' }, getCreates: () => creates,
  recoverBinding: () => { bindFails = false; } };
}

test('concurrent retries of confirmed cancellation share one immutable payment attempt', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    resumeSuccessorPaymentAttempt(f.db, f.stripe, f.reservation, f.cancelled, '2026-11-01')));
  assert.ok(results.every(row => row.id === 'pi_replacement'));
  assert.equal(f.getCreates(), 1);
});

test('provider success followed by local failure retries the same key and frozen amount', async () => {
  const f = fixture({ bindFails: true });
  await assert.rejects(resumeSuccessorPaymentAttempt(f.db, f.stripe, f.reservation, f.cancelled, '2026-11-01'), /bind/);
  f.recoverBinding();
  await resumeSuccessorPaymentAttempt(f.db, f.stripe, f.reservation, f.cancelled, '2026-11-01');
  assert.equal(f.getCreates(), 1);
});

test('unknown provider outcome and an expired unbound attempt cannot create a replacement', async () => {
  const f = fixture();
  await assert.rejects(resumeSuccessorPaymentAttempt(f.db, f.stripe, f.reservation,
    { id: 'pi_unknown', status: 'processing' }, '2026-11-01'), /Confirmed cancellation/);
  await assert.rejects(resumeSuccessorPaymentAttempt(f.db, f.stripe, f.reservation,
    f.cancelled, '2026-11-03'), /reconciliation/);
  assert.equal(f.getCreates(), 0);
});