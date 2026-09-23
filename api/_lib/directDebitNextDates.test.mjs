import test from 'node:test';
import assert from 'node:assert/strict';
import { directDebitNextDates, loadDirectDebitNextDates } from './directDebitNextDates.js';

const plan = { id: 'plan', tenant_id: 'tenant', billing_agreement_id: 'agreement',
  gocardless_mandate_id: 'MD1', environment: 'live', status: 'active',
  metadata: { collection_mode: 'dynamic' }, dynamic_next_collection_date: '2026-10-01',
  next_charge_date: '2025-01-01' };
const payment = { id: 'payment', plan_id: 'plan', tenant_id: 'tenant',
  gocardless_mandate_id: 'MD1', environment: 'live', gocardless_payment_id: 'PM1',
  charge_date: '2026-10-05', status: 'pending_submission' };
const shape = (p = plan, payments = []) => directDebitNextDates(p, payments, '2026-09-20');

test('dynamic cadence is planned, not a bank debit; holds do not erase the plan', () => {
  assert.deepEqual(shape(), { dynamic: true, nextDueDate: '2026-10-01',
    bankScheduledDate: null, nextChargeDate: null, status: 'not_yet_scheduled' });
  assert.equal(shape({ ...plan, collection_stopped_at: '2026-09-01' }).nextDueDate, '2026-10-01');
  assert.equal(shape({ ...plan, dynamic_next_collection_date: null }).nextDueDate, null);
});

test('only canonical pending provider payment evidence supplies a bank date', () => {
  assert.equal(shape(plan, [payment]).bankScheduledDate, '2026-10-05');
  for (const patch of [
    { status: 'cancelled' }, { status: 'failed' }, { status: 'confirmed' }, { status: 'paid_out' },
    { status: 'pending_customer_approval' }, { charge_date: '2026-09-01' },
    { gocardless_payment_id: null }, { tenant_id: 'other' }, { plan_id: 'other' },
    { billing_agreement_id: 'other' }, { gocardless_mandate_id: 'other' }, { environment: 'sandbox' },
  ]) assert.equal(shape(plan, [{ ...payment, ...patch }]).bankScheduledDate, null, JSON.stringify(patch));
  assert.equal(shape(plan, [{ due_date: '2026-10-01', requested_charge_date: '2026-10-05' }]).bankScheduledDate, null);
});

test('completed, cancelled and paused dynamic plans never fall back to an old mirror', () => {
  for (const status of ['completed', 'payment_plan_cancelled', 'cancelled', 'paused']) {
    assert.deepEqual(shape({ ...plan, status }, [payment]), {
      dynamic: true, nextDueDate: null, bankScheduledDate: null, nextChargeDate: null, status: 'inactive',
    });
  }
});

test('legacy dates keep their existing semantics', () => {
  assert.deepEqual(shape({ ...plan, metadata: {} }), { dynamic: false, nextDueDate: '2025-01-01',
    bankScheduledDate: null, nextChargeDate: '2025-01-01', status: 'legacy' });
});

test('evidence loads in tenant-scoped batches rather than per plan; failures surface', async () => {
  const calls = [];
  const db = { from(table) {
    const call = { table, filters: [] }; calls.push(call);
    return { select() { return this; }, eq(...args) { call.filters.push(args); return this; },
      in(...args) { call.filters.push(args); return this; }, order() { return this; },
      async range() { return { data: [] }; } };
  } };
  const plans = Array.from({ length: 105 }, (_, i) => ({ ...plan, id: String(i) }));
  const result = await loadDirectDebitNextDates(db, 'tenant', plans);
  assert.equal(result.size, 105);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].filters[0], ['tenant_id', 'tenant']);
  assert.equal(calls[0].filters[1][1].length, 100);
  const broken = { from() { return { select() { return this; }, eq() { return this; },
    in() { return this; }, order() { return this; }, range: async () => ({ error: { message: 'offline' } }) }; } };
  await assert.rejects(loadDirectDebitNextDates(broken, 'tenant', [plan]), /offline/);
});