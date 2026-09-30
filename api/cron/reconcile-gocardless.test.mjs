import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReconcileGocardlessHandler,
  reconcileStalePayments,
} from './reconcile-gocardless.js';

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('cron fails closed with 503 when CRON_SECRET is unset', { concurrency: false }, async () => {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    let reconciliationCalls = 0;
    const handler = createReconcileGocardlessHandler({
      execute: async () => { reconciliationCalls += 1; },
    });
    const res = responseRecorder();
    await handler({ headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'Cron authentication is not configured' });
    assert.equal(reconciliationCalls, 0);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test('cron rejects an invalid bearer token before reconciliation', { concurrency: false }, async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'configured-test-secret';
  try {
    let reconciliationCalls = 0;
    const handler = createReconcileGocardlessHandler({
      execute: async () => { reconciliationCalls += 1; },
    });
    const res = responseRecorder();
    await handler({ headers: { authorization: 'Bearer wrong' } }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'Unauthorized' });
    assert.equal(reconciliationCalls, 0);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

function fakeDb(initial) {
  const tables = Object.fromEntries(
    Object.entries(initial).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
  );
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = 'select';
      this.payload = null;
      this.ordering = null;
      this.rowLimit = null;
    }
    select() { return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    lt(column, value) { this.filters.push((row) => row[column] < value); return this; }
    order(column, options = {}) { this.ordering = { column, ascending: options.ascending !== false }; return this; }
    limit(value) { this.rowLimit = value; return this; }
    rows() {
      let rows = (tables[this.table] || []).filter((row) => this.filters.every((filter) => filter(row)));
      if (this.ordering) {
        const { column, ascending } = this.ordering;
        rows = [...rows].sort((a, b) => {
          const comparison = String(a[column]).localeCompare(String(b[column]));
          return ascending ? comparison : -comparison;
        });
      }
      return this.rowLimit == null ? rows : rows.slice(0, this.rowLimit);
    }
    run() {
      const rows = this.rows();
      if (this.operation === 'update') rows.forEach((row) => Object.assign(row, this.payload));
      return { data: rows.map((row) => ({ ...row })), error: null };
    }
    maybeSingle() {
      const result = this.run();
      return Promise.resolve({ data: result.data[0] || null, error: result.error });
    }
    then(resolve, reject) {
      try {
        resolve(this.run());
      } catch (error) {
        reject(error);
      }
    }
  }
  return {
    tables,
    from(table) {
      return new Query(table);
    },
  };
}

test('stale confirmed mirror with unfinished lifecycle is replayed when provider is unchanged', async () => {
  const old = '2020-01-01T00:00:00.000Z';
  const db = fakeDb({
    gocardless_payments: [{
      id: 'payment-1',
      tenant_id: 'tenant-1',
      plan_id: 'plan-1',
      gocardless_payment_id: 'PM1',
      gocardless_subscription_id: 'SB1',
      gocardless_mandate_id: 'MD1',
      status: 'confirmed',
      updated_at: old,
    }],
    membership_payment_plans: [{
      id: 'plan-1',
      tenant_id: 'tenant-1',
      billing_agreement_id: 'agreement-1',
      status: 'first_payment_pending',
    }],
    membership_billing_agreements: [{
      id: 'agreement-1',
      tenant_id: 'tenant-1',
      member_id: 'member-1',
      status: 'first_payment_pending',
      metadata: {
        dd: {
          kind: 'monthly_direct_debit',
          activation_rule: 'first_payment',
        },
      },
    }],
    member_membership_history: [{
      billing_agreement_id: 'agreement-1',
      status: 'pending_payment_setup',
      payment_status: 'unpaid',
    }],
  });
  const events = [];
  const results = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };

  await reconcileStalePayments(results, {
    db,
    gcForTenant: async (tenantId) => {
      assert.equal(tenantId, 'tenant-1');
      return {
        getPayment: async () => ({
          id: 'PM1',
          status: 'confirmed',
          links: { subscription: 'SB1', mandate: 'MD1' },
        }),
      };
    },
    processEvent: async (event, deps) => {
      assert.equal(deps.db, db);
      events.push(event);
      db.tables.membership_payment_plans[0].status = 'active';
      db.tables.membership_billing_agreements[0].status = 'active';
      db.tables.member_membership_history[0].status = 'active';
      db.tables.member_membership_history[0].payment_status = 'partial';
      return { handled: true };
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'confirmed');
  assert.equal(events[0].resource_type, 'payments');
  assert.equal(results.repaired, 1);
  assert.equal(results.errors, 0);
  assert.equal(db.tables.member_membership_history[0].payment_status, 'partial');
});

test('bounded confirmed scan rotates 100 completed rows so a newer obligation is not starved', async () => {
  const tenantId = 'tenant-fairness';
  const oldRows = Array.from({ length: 100 }, (_, index) => ({
    id: `completed-payment-${String(index).padStart(3, '0')}`,
    tenant_id: tenantId,
    plan_id: `completed-plan-${index}`,
    gocardless_payment_id: `PM-COMPLETE-${index}`,
    status: 'confirmed',
    updated_at: `2020-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
  }));
  const db = fakeDb({
    gocardless_payments: [
      ...oldRows,
      {
        id: 'unfinished-payment',
        tenant_id: tenantId,
        plan_id: 'unfinished-plan',
        gocardless_payment_id: 'PM-UNFINISHED',
        status: 'confirmed',
        updated_at: '2020-01-02T00:00:00.000Z',
      },
    ],
    membership_payment_plans: [
      ...oldRows.map((row, index) => ({
        id: row.plan_id,
        tenant_id: tenantId,
        billing_agreement_id: `completed-agreement-${index}`,
        status: 'expired',
      })),
      {
        id: 'unfinished-plan',
        tenant_id: tenantId,
        billing_agreement_id: 'unfinished-agreement',
        status: 'first_payment_pending',
      },
    ],
    membership_billing_agreements: [
      ...oldRows.map((row, index) => ({
        id: `completed-agreement-${index}`,
        tenant_id: tenantId,
        member_id: `completed-member-${index}`,
        status: 'expired',
        metadata: { dd: { kind: 'monthly_direct_debit', activation_rule: 'first_payment' } },
      })),
      {
        id: 'unfinished-agreement',
        tenant_id: tenantId,
        member_id: 'unfinished-member',
        status: 'first_payment_pending',
        metadata: { dd: { kind: 'monthly_direct_debit', activation_rule: 'first_payment' } },
      },
    ],
    member_membership_history: [],
  });
  let providerReads = 0;
  const processed = [];
  const deps = {
    db,
    gcForTenant: async () => ({
      getPayment: async (paymentId) => {
        providerReads += 1;
        return { id: paymentId, status: 'confirmed' };
      },
    }),
    processEvent: async (event) => {
      processed.push(event);
      return { handled: true };
    },
  };

  const first = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };
  await reconcileStalePayments(first, deps);
  assert.equal(providerReads, 100);
  assert.equal(processed.length, 0);

  const second = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };
  await reconcileStalePayments(second, deps);
  assert.equal(providerReads, 101);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].links.payment, 'PM-UNFINISHED');
  assert.equal(second.repaired, 1);
});