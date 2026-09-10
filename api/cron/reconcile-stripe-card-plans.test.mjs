import test from 'node:test';
import assert from 'node:assert/strict';
import handler, {
  reconcilePostGraceCatchUps,
  reconcileStalePlans,
} from './reconcile-stripe-card-plans.js';

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('cron fails closed with 503 when CRON_SECRET is unset', async () => {
  const prior = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const res = responseRecorder();
    await handler({ headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'Cron authentication is not configured' });
  } finally {
    if (prior === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  }
});

test('cron rejects an invalid authorization header before processing', async () => {
  const prior = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'configured-test-secret';
  try {
    const res = responseRecorder();
    await handler({ headers: { authorization: 'Bearer wrong-secret' } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
  } finally {
    if (prior === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  }
});

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

function stalePlansDb(initialPlans) {
  const plans = initialPlans.map((plan) => ({ ...plan }));
  const touches = [];
  return {
    plans,
    touches,
    from(table) {
      assert.equal(table, 'membership_payment_plans');
      const filters = [];
      const orders = [];
      let max = Infinity;
      let updatePayload = null;
      const chain = {
        select() { return chain; },
        eq(key, value) { filters.push(['eq', key, value]); return chain; },
        not(key, op, value) { filters.push(['not', key, value, op]); return chain; },
        in(key, values) { filters.push(['in', key, values]); return chain; },
        lt(key, value) { filters.push(['lt', key, value]); return chain; },
        order(key) { orders.push(key); return chain; },
        limit(value) { max = value; return chain; },
        update(payload) { updatePayload = payload; return chain; },
        async maybeSingle() {
          const result = execute();
          return { data: result.data[0] || null, error: null };
        },
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      };
      function execute() {
        let rows = plans.filter((plan) => filters.every(([kind, key, value, op]) => {
          if (kind === 'eq') return plan[key] === value;
          if (kind === 'not' && op === 'is') return value === null ? plan[key] != null : plan[key] !== value;
          if (kind === 'in') return value.includes(plan[key]);
          if (kind === 'lt') return String(plan[key]) < String(value);
          return true;
        }));
        if (orders.length) {
          rows = [...rows].sort((a, b) => {
            for (const key of orders) {
              const compared = String(a[key] || '').localeCompare(String(b[key] || ''));
              if (compared) return compared;
            }
            return 0;
          });
        }
        rows = rows.slice(0, max);
        if (updatePayload) {
          rows.forEach((row) => {
            touches.push({ id: row.id, prior: row.updated_at, next: updatePayload.updated_at });
            Object.assign(row, updatePayload);
          });
        }
        return { data: rows, error: null };
      }
      return chain;
    },
  };
}

const noInvoiceClient = {
  subscriptions: { retrieve: async () => ({ status: 'active' }) },
  invoices: { list: async () => ({ data: [] }) },
};

function reconciliationResults() {
  return { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };
}

test('stale plan reconciliation repairs remote cancellation after a handled counted invoice', async () => {
  const plan = {
    id: 'cancelled-plan',
    tenant_id: 'tenant-1',
    provider: 'stripe',
    stripe_subscription_id: 'sub-cancelled',
    status: 'active',
    updated_at: '2020-01-01T00:00:00.000Z',
    instalments_total: 3,
    instalments_paid: 1,
    metadata: { paid_invoice_ids: ['in-counted'] },
  };
  const db = stalePlansDb([plan]);
  const client = {
    subscriptions: { retrieve: async () => ({ status: 'canceled' }) },
    invoices: {
      list: async () => ({
        data: [{ id: 'in-counted', status: 'paid', paid: true }],
      }),
    },
  };
  const transitions = [];
  const results = reconciliationResults();
  await reconcileStalePlans(results, {
    db,
    getClients: async () => [client],
    replay: async () => ({ handled: true, detail: 'already counted' }),
    transition: async (args) => {
      transitions.push(args);
      return { applied: true };
    },
  });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].entityId, plan.id);
  assert.equal(transitions[0].toStatus, 'payment_plan_cancelled');
  assert.equal(results.repaired, 1);
  assert.equal(results.errors, 0);
});

test('first-payment-pending plans have nonstarvable capacity beyond 100 established rows', async () => {
  const established = Array.from({ length: 101 }, (_, index) => ({
    id: `established-${String(index).padStart(3, '0')}`,
    tenant_id: 'tenant-1',
    provider: 'stripe',
    stripe_subscription_id: `sub-established-${index}`,
    status: 'active',
    updated_at: `2020-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    instalments_total: 12,
    instalments_paid: 1,
    metadata: {},
  }));
  const pending = {
    id: 'pending-must-run',
    tenant_id: 'tenant-1',
    provider: 'stripe',
    stripe_subscription_id: 'sub-pending',
    status: 'first_payment_pending',
    updated_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    instalments_total: 12,
    instalments_paid: 0,
    metadata: {},
  };
  const db = stalePlansDb([...established, pending]);
  const examined = [];
  const results = reconciliationResults();
  await reconcileStalePlans(results, {
    db,
    getClients: async (tenantId) => {
      examined.push(tenantId);
      return [noInvoiceClient];
    },
  });
  assert.equal(examined.length, 101, '100 established plus an independent pending budget row');
  assert.ok(db.touches.some((touch) => touch.id === pending.id), 'eligible pending row was processed');
});

test('CAS rotation prevents failed and skipped established rows monopolising later bounded runs', async () => {
  const db = stalePlansDb([
    {
      id: 'oldest-fails',
      tenant_id: 'tenant-fail',
      provider: 'stripe',
      stripe_subscription_id: 'sub-fail',
      status: 'active',
      updated_at: '2020-01-01T00:00:00.000Z',
      metadata: {},
    },
    {
      id: 'next-skips',
      tenant_id: 'tenant-skip',
      provider: 'stripe',
      stripe_subscription_id: 'sub-skip',
      status: 'active',
      updated_at: '2020-01-02T00:00:00.000Z',
      metadata: {},
    },
  ]);
  const examined = [];
  const getClients = async (tenantId) => {
    examined.push(tenantId);
    if (tenantId === 'tenant-fail') throw new Error('credential failure');
    return [noInvoiceClient];
  };
  await reconcileStalePlans(reconciliationResults(), {
    db, establishedBudget: 1, getClients,
  });
  await reconcileStalePlans(reconciliationResults(), {
    db, establishedBudget: 1, getClients,
  });
  assert.deepEqual(examined, ['tenant-fail', 'tenant-skip']);
  assert.deepEqual(db.touches.map((touch) => touch.id), ['oldest-fails', 'next-skips']);
});