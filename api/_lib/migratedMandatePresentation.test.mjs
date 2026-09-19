import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMigratedMandatePresentation, migratedMandatePresentation } from './migratedMandatePresentation.js';
import { shapePlan } from '../membership/payment-plan.js';

const plan = (patch = {}) => ({
  provider: 'gocardless', tenant_id: 'tenant', environment: 'live',
  gocardless_mandate_id: 'MD-existing', status: 'mandate_pending',
  membership_billing_agreements: { metadata: { dd: {
    billing_request_mode: 'migration_existing_mandate', activation_rule: 'first_payment',
  } } }, ...patch,
});
function db(mandate, error = null) {
  const filters = [];
  return { filters, from(table) {
    assert.equal(table, 'gocardless_mandates');
    return { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; },
      async maybeSingle() { return { data: mandate, error }; } };
  } };
}
test('migration mode alone does not establish active mandate; normal signups do not query mirrors', async () => {
  assert.equal(migratedMandatePresentation(null), null);
  assert.equal(migratedMandatePresentation(undefined), null);
  assert.equal(await loadMigratedMandatePresentation({}, null), null);
  assert.equal(migratedMandatePresentation(plan()), null);
  const signup = plan({ membership_billing_agreements: { metadata: { dd: { billing_request_mode: 'mandate_only' } } } });
  assert.equal(await loadMigratedMandatePresentation({}, signup), signup);
  assert.equal(migratedMandatePresentation({ ...signup, migratedMandateStatus: 'active' }), null);
});
test('active mirror is tenant, identity and environment scoped, read-only and separate from lifecycle', async () => {
  const store = db({ tenant_id: 'tenant', environment: 'live', gocardless_mandate_id: 'MD-existing', status: 'active' });
  const original = plan();
  const evidenced = await loadMigratedMandatePresentation(store, original);
  assert.deepEqual(store.filters, [['tenant_id', 'tenant'], ['gocardless_mandate_id', 'MD-existing'], ['environment', 'live']]);
  assert.equal(original.migratedMandateStatus, undefined);
  assert.equal(shapePlan(evidenced).status, 'mandate_pending');
  assert.deepEqual(shapePlan(evidenced).mandatePresentation, {
    mandateStatus: 'active', awaitingFirstPayment: true, collectionHeld: false, label: 'Awaiting first payment',
  });
  for (const status of ['cancelled', 'failed', 'pending_submission']) {
    assert.equal(migratedMandatePresentation({ ...evidenced, migratedMandateStatus: status }), null);
  }
  for (const mismatch of [{ tenant_id: 'other' }, { environment: 'test' }, { gocardless_mandate_id: 'other' }]) {
    const bad = db({ tenant_id: 'tenant', environment: 'live', gocardless_mandate_id: 'MD-existing', status: 'active', ...mismatch });
    assert.equal(migratedMandatePresentation(await loadMigratedMandatePresentation(bad, original)), null);
  }
  await assert.rejects(loadMigratedMandatePresentation(db(null, new Error('mirror unavailable')), original), /mirror unavailable/);
});
test('collection hold and failure are never hidden by an active mandate', () => {
  const held = plan({ migratedMandateStatus: 'active', collection_stopped_at: '2026-09-18' });
  assert.equal(migratedMandatePresentation(held).collectionHeld, true);
  assert.equal(migratedMandatePresentation({ ...held, collection_stopped_at: null, metadata: { bnms_release_required: true } }).collectionHeld, true);
  for (const status of ['active', 'payment_failed', 'cancelled', 'completed']) {
    assert.equal(migratedMandatePresentation({ ...held, status }).awaitingFirstPayment, false);
  }
});