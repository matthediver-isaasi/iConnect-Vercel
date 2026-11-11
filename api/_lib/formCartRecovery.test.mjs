import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelCartPayment } from './formCartRecovery.js';
import { handleCancelCart } from '../public/form-payment.js';
const row = { id: 'submission', tenant_id: 'tenant', form_id: 'form', payment_provider: 'stripe', payment_status: 'pending', payment_reference: 'pi_1' };
function fixture(status, state = 'held') {
  const calls = [];
  const db = {
    from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { state } }) }; return q; },
    rpc: async (name, args) => { calls.push({ name, args }); return {}; },
  };
  const pi = { id: 'pi_1', status, metadata: { form_submission_id: row.id, form_id: row.form_id, tenant_id: row.tenant_id } };
  const retrieve = async () => ({ paymentIntent: pi, stripe: { paymentIntents: { cancel: async () => { calls.push('cancel'); return { ...pi, status: 'canceled' }; } } } });
  return { db, calls, retrieve, pi };
}
test('only verified cancellation releases stock; terminal retry is idempotent', async () => {
  const f = fixture('requires_payment_method');
  assert.deepEqual(await cancelCartPayment(f.db, row, f.retrieve), { released: true });
  assert.equal(f.calls[0], 'cancel');
  assert.equal(f.calls[1].args.p_release_evidence.reference, 'pi_1');
  const retry = fixture('canceled', 'released');
  await cancelCartPayment(retry.db, row, () => { throw Error('must not retrieve'); });
  assert.equal(retry.calls.length, 0);
});
for (const status of ['succeeded', 'processing', 'requires_capture']) {
  test(`${status} cannot release or cancel`, async () => {
    const f = fixture(status);
    await assert.rejects(cancelCartPayment(f.db, row, f.retrieve));
    assert.equal(f.calls.length, 0);
  });
}
test('wrong provider identity and provider failure preserve stock', async () => {
  const f = fixture('requires_action'); f.pi.metadata.tenant_id = 'other';
  await assert.rejects(cancelCartPayment(f.db, row, f.retrieve));
  await assert.rejects(cancelCartPayment(f.db, row, async () => { throw Error('timeout'); }));
  assert.equal(f.calls.length, 0);
});
test('paid, invoice, monthly and confirmed orders are protected', async () => {
  for (const override of [{ payment_status: 'paid' }, { payment_provider: 'invoice' }, { payment_meta: { monthly_card: {} } }]) {
    const f = fixture('requires_action');
    await assert.rejects(cancelCartPayment(f.db, { ...row, ...override }, f.retrieve));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture('requires_action', 'consumed');
  await assert.rejects(cancelCartPayment(f.db, row, f.retrieve));
  assert.equal(f.calls.length, 0);
});

test('cancellation lookup is tenant/form/original-key scoped; missing keys fail closed', async () => {
  const filters = [];
  const db = { from(table) {
    assert.equal(table, 'form_submission');
    const q = { select: () => q, eq: (key, value) => { filters.push([key, value]); return q; },
      maybeSingle: async () => ({ data: null }) };
    return q;
  } };
  const res = { status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await handleCancelCart({ body: { form_id: 'form' } }, res, db, { id: 'tenant' });
  assert.equal(res.statusCode, 400); assert.equal(filters.length, 0);
  await handleCancelCart({ body: { form_id: 'form', idempotency_key: 'original-checkout-key' } }, res, db, { id: 'tenant' });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(filters, [['tenant_id', 'tenant'], ['form_id', 'form'], ['idempotency_key', 'pay:original-checkout-key']]);
});
