import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupFormBundleHolds } from './formBundleCleanup.js';
function fixture(row) {
  const calls = [];
  const query = data => ({ select() { return this; }, eq() { return this; }, lte() { return this; },
    order() { return this; }, limit() { return this; }, single() { return this; },
    then(resolve) { resolve({ data }); } });
  return { calls, from(table) { return query(table === 'form_bundle_allocation'
    ? [{ tenant_id: 't', submission_id: 's' }] : row); },
  rpc: async (name, args) => { calls.push({ name, args }); return { data: {} }; } };
}
const row = { id: 's', tenant_id: 't', form_id: 'f', payment_provider: 'stripe',
  payment_reference: 'pi_fixture', payment_status: 'pending' };
const pi = { id: row.payment_reference, metadata: { form_submission_id: 's', tenant_id: 't', form_id: 'f' } };
test('age alone cannot release a missing or processing payment', async () => {
  for (const state of ['missing','processing','succeeded','mismatch']) {
    const db = fixture(state === 'missing' ? { ...row, payment_reference: null } : row);
    await cleanupFormBundleHolds(db, { retrieveStripe: async () => ({ paymentIntent: {
      ...pi, status: state, ...(state === 'mismatch' ? { metadata: {} } : {}),
    } }) });
    assert.equal(db.calls.some(c => c.name === 'finalize_form_bundle'), false);
    assert.equal(db.calls[0].name, 'defer_form_bundle_check');
  }
});
test('only a verified cancellation releases, and provider errors retain stock', async () => {
  for (const cancelled of [false,true]) {
    const db = fixture(row);
    await cleanupFormBundleHolds(db, { retrieveStripe: async () => ({
      paymentIntent: { ...pi, status: 'requires_action' },
      stripe: { paymentIntents: { cancel: async () => {
        if (!cancelled) throw new Error('provider unavailable');
        return { ...pi, status: 'canceled' };
      } } },
    }) });
    assert.equal(db.calls[0].name, cancelled ? 'finalize_form_bundle' : 'defer_form_bundle_check');
    if (cancelled) assert.equal(db.calls[0].args.p_release_evidence.reference, row.payment_reference);
  }
});
