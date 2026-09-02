import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePostGraceCatchUps } from './reconcile-stripe-card-plans.js';

function queryDb(plans) {
  const calls = [];
  return { calls, from() {
    const q = {
      select() { return q; }, eq(k, v) { calls.push(['eq', k, v]); return q; },
      in(k, v) { calls.push(['in', k, v]); return q; },
      not(k, op, v) { calls.push(['not', k, op, v]); return q; },
      lte(k, v) { calls.push(['lte', k, v]); return q; },
      order(k) { calls.push(['order', k]); return q; },
      limit(v) { calls.push(['limit', v]); return q; },
      then(resolve) { return Promise.resolve({ data: plans, error: null }).then(resolve); },
    };
    return q;
  } };
}

test('Stripe expired failed plan accrues before post-grace collection', async () => {
  const plan = {
    id: 'p1', tenant_id: 't1', provider: 'stripe', interval_unit: 'monthly',
    status: 'payment_overdue', grace_expires_at: '2026-01-10',
    failed_due_period: '2026-01-01',
    next_charge_date: '2026-01-01', last_payment_id: 'in_failed',
    membership_billing_agreements: { id: 'a1', tenant_id: 't1' },
  };
  const db = queryDb([plan]);
  const sequence = [];
  const results = { repaired: 0, skipped: 0, errors: 0 };
  await reconcilePostGraceCatchUps(results, {
    db, nowIso: '2026-02-01', getCreds: async () => ({}), makeClients: () => [{}],
    accrue: async (args) => { sequence.push('accrue'); assert.equal(args.duePeriod, '2026-01-01'); assert.equal(args.tenantId, 't1'); },
    execute: async () => { sequence.push('execute'); return { created: true }; },
  });
  assert.deepEqual(sequence, ['accrue', 'execute']);
  assert.equal(results.repaired, 1);
});

test('Stripe reconciliation excludes in-grace plans and is deterministically bounded', async () => {
  const db = queryDb([]);
  let accrued = 0;
  await reconcilePostGraceCatchUps({ repaired: 0, skipped: 0, errors: 0 }, {
    db, nowIso: '2026-02-01', maxRows: 19,
    accrue: async () => { accrued++; }, execute: async () => ({ created: true }),
  });
  assert.equal(accrued, 0);
  assert.ok(db.calls.some((c) => c[0] === 'lte' && c[1] === 'grace_expires_at' && c[2] === '2026-02-01'));
  assert.deepEqual(db.calls.filter((c) => c[0] === 'order').map((c) => c[1]), ['grace_expires_at', 'id']);
  assert.ok(db.calls.some((c) => c[0] === 'limit' && c[1] === 19));
});