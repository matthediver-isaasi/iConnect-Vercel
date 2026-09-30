import test from 'node:test';
import assert from 'node:assert/strict';
import { runMonthlyCollectionSweep } from './gocardless-arrears.js';

function fakeDb(plans, agreements) {
  const calls = [];
  return { calls, from(table) {
    const filters = {};
    const q = {
      select() { return q; }, in(k, v) { calls.push(['in', k, v]); return q; },
      neq(k, v) { calls.push(['neq', k, v]); return q; },
      eq(k, v) { filters[k] = v; calls.push(['eq', k, v]); return q; },
      not(k, op, v) { calls.push(['not', k, op, v]); return q; },
      lte(k, v) { calls.push(['lte', k, v]); return q; },
      order(k) { calls.push(['order', k]); return q; },
      limit(n) { calls.push(['limit', n]); return q; },
      maybeSingle: async () => ({
        data: agreements.find((a) => a.id === filters.id && a.tenant_id === filters.tenant_id) || null,
        error: null,
      }),
      then(resolve) { return Promise.resolve({ data: table === 'membership_payment_plans' ? plans : [], error: null }).then(resolve); },
    };
    return q;
  } };
}

const overdue = {
  id: 'p1', tenant_id: 't1', billing_agreement_id: 'a1', provider: 'gocardless',
  interval_unit: 'monthly', status: 'payment_overdue', grace_expires_at: '2026-01-01',
  next_charge_date: '2026-01-01', arrears_policy_applied: 'keep_active',
  failed_due_period: '2026-01-01',
};
const agreement = { id: 'a1', tenant_id: 't1', metadata: { dd: { monthly_post_grace_collection_policy: 'continue_catch_up' } } };

test('collection remains independent of one-time keep_active/manual_review access policy', async () => {
  const seen = [];
  const db = fakeDb([{ ...overdue }, { ...overdue, id: 'p2', arrears_policy_applied: 'manual_review' }], [agreement, { ...agreement, id: 'a1' }]);
  const out = await runMonthlyCollectionSweep({
    db, getGc: async (tenant) => ({ tenant }),
    accrue: async ({ plan }) => seen.push(`accrue:${plan.id}`),
    execute: async ({ plan }) => { seen.push(`execute:${plan.id}`); return { created: true }; },
  });
  assert.equal(out.scanned, 2);
  assert.equal(out.created, 2);
  assert.deepEqual(seen, ['accrue:p1', 'execute:p1', 'accrue:p2', 'execute:p2']);
});

test('provider failure is counted and a later sweep retries the same plan', async () => {
  const db = fakeDb([overdue], [agreement]);
  let attempts = 0;
  const deps = {
    db, getGc: async () => ({}), accrue: async () => {},
    execute: async () => { attempts++; if (attempts === 1) throw new Error('provider down'); return { created: true }; },
  };
  assert.equal((await runMonthlyCollectionSweep(deps)).errors, 1);
  assert.equal((await runMonthlyCollectionSweep(deps)).created, 1);
  assert.equal(attempts, 2);
});

test('later missed open set is executed as a new catch-up on a later sweep', async () => {
  const db = fakeDb([overdue], [agreement]);
  const keys = ['period-1', 'period-1,period-2'];
  const observed = [];
  for (const key of keys) {
    await runMonthlyCollectionSweep({
      db, getGc: async () => ({}), accrue: async () => {},
      execute: async () => { observed.push(key); return { created: true, intentKey: key }; },
    });
  }
  assert.deepEqual(observed, keys);
});

test('collection query is bounded, deterministic, grace-expired, tenant scoped, and uses tenant credentials', async () => {
  const db = fakeDb([overdue], [agreement]);
  const tenants = [];
  await runMonthlyCollectionSweep({ db, maxRows: 17, nowIso: '2026-02-01',
    getGc: async (tenant) => { tenants.push(tenant); return {}; },
    accrue: async () => {}, execute: async () => ({ created: false }),
  });
  assert.deepEqual(db.calls.filter((c) => c[0] === 'order').map((c) => c[1]), ['grace_expires_at', 'id']);
  assert.ok(db.calls.some((c) => c[0] === 'limit' && c[1] === 17));
  assert.ok(db.calls.some((c) => c[0] === 'lte' && c[2] === '2026-02-01'));
  assert.deepEqual(tenants, ['t1']);
  assert.ok(db.calls.some((c) => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === 't1'));
});