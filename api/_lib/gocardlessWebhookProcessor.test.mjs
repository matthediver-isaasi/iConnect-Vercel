// GoCardless state machine + webhook processor tests (fake supabase db).
// Run: node --test api/_lib/gocardlessWebhookProcessor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { canTransition, applyStatusTransition, STATUS } from './gocardlessState.js';
import { processGocardlessEvent } from './gocardlessWebhookProcessor.js';

// ---------------------------------------------------------------------------
// Minimal in-memory supabase-shaped fake
// ---------------------------------------------------------------------------

function makeFakeDb(initial = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(initial)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  const ensure = (name) => (tables[name] ||= []);

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = null;
      this.payload = null;
      this.upsertOpts = null;
      this._selectAfter = false;
    }
    select() { if (this.op) this._selectAfter = true; else this.op = 'select'; return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    upsert(payload, opts) { this.op = 'upsert'; this.payload = payload; this.upsertOpts = opts || {}; return this; }
    eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
    is(col, val) { this.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
    in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
    not() { return this; }
    lt(col, val) { this.filters.push((r) => r[col] < val); return this; }
    order() { return this; }
    limit() { return this; }
    _matches() { return ensure(this.table).filter((r) => this.filters.every((f) => f(r))); }
    _run() {
      const rows = ensure(this.table);
      if (this.op === 'insert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const p of list) rows.push({ id: p.id || crypto.randomUUID(), ...p });
        return { data: list, error: null };
      }
      if (this.op === 'upsert') {
        const conflictCols = (this.upsertOpts.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const out = [];
        for (const p of list) {
          const existing = conflictCols.length
            ? rows.find((r) => conflictCols.every((c) => r[c] === p[c]))
            : null;
          if (existing) {
            if (this.upsertOpts.ignoreDuplicates) continue;
            Object.assign(existing, p);
            out.push(existing);
          } else {
            const row = { id: p.id || crypto.randomUUID(), ...p };
            rows.push(row);
            out.push(row);
          }
        }
        return { data: out, error: null };
      }
      if (this.op === 'update') {
        const matched = this._matches();
        for (const r of matched) Object.assign(r, this.payload);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      return { data: this._matches().map((r) => ({ ...r })), error: null };
    }
    maybeSingle() {
      const { data, error } = this._run();
      return Promise.resolve({ data: data[0] || null, error });
    }
    then(resolve, reject) {
      try { resolve(this._run()); } catch (e) { reject(e); }
    }
  }

  return {
    tables,
    from(table) { return new Query(table); },
  };
}

const TENANT = '11111111-1111-1111-1111-111111111111';

// ---------------------------------------------------------------------------
// canTransition matrix
// ---------------------------------------------------------------------------

test('canTransition: forward path allowed', () => {
  assert.equal(canTransition(STATUS.PAYMENT_SETUP_REQUIRED, STATUS.MANDATE_PENDING), true);
  assert.equal(canTransition(STATUS.MANDATE_PENDING, STATUS.FIRST_PAYMENT_PENDING), true);
  assert.equal(canTransition(STATUS.FIRST_PAYMENT_PENDING, STATUS.ACTIVE), true);
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.PAYMENT_GRACE_PERIOD), true);
  assert.equal(canTransition(STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE), true);
});

test('canTransition: recovery paths allowed', () => {
  assert.equal(canTransition(STATUS.PAYMENT_GRACE_PERIOD, STATUS.ACTIVE), true);
  assert.equal(canTransition(STATUS.PAYMENT_OVERDUE, STATUS.ACTIVE), true);
});

test('canTransition: regressions rejected (out-of-order protection)', () => {
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.MANDATE_PENDING), false);
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.FIRST_PAYMENT_PENDING), false);
  assert.equal(canTransition(STATUS.FIRST_PAYMENT_PENDING, STATUS.MANDATE_PENDING), false);
});

test('canTransition: terminal statuses are terminal', () => {
  for (const to of Object.values(STATUS)) {
    assert.equal(canTransition(STATUS.PAYMENT_PLAN_CANCELLED, to), false);
    assert.equal(canTransition(STATUS.EXPIRED, to), false);
  }
});

test('canTransition: cancellation allowed from every non-terminal state', () => {
  for (const from of [STATUS.PAYMENT_SETUP_REQUIRED, STATUS.MANDATE_PENDING, STATUS.FIRST_PAYMENT_PENDING, STATUS.ACTIVE, STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE]) {
    assert.equal(canTransition(from, STATUS.PAYMENT_PLAN_CANCELLED), true, from);
  }
});

// ---------------------------------------------------------------------------
// applyStatusTransition
// ---------------------------------------------------------------------------

test('applyStatusTransition applies a valid transition and writes history', async () => {
  const db = makeFakeDb({
    membership_payment_plans: [{ id: 'plan-1', tenant_id: TENANT, status: STATUS.FIRST_PAYMENT_PENDING }],
    membership_payment_status_history: [],
  });
  const result = await applyStatusTransition({
    entityType: 'payment_plan', entityId: 'plan-1', toStatus: STATUS.ACTIVE,
    reason: 'payment confirmed', source: 'webhook', eventId: 'EV1',
  }, { db });
  assert.equal(result.applied, true);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.ACTIVE);
  const hist = db.tables.membership_payment_status_history;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].from_status, STATUS.FIRST_PAYMENT_PENDING);
  assert.equal(hist[0].to_status, STATUS.ACTIVE);
  assert.equal(hist[0].event_id, 'EV1');
  assert.equal(hist[0].source, 'webhook');
});

test('applyStatusTransition is a no-op for duplicate status (idempotent)', async () => {
  const db = makeFakeDb({
    membership_payment_plans: [{ id: 'plan-1', tenant_id: TENANT, status: STATUS.ACTIVE }],
    membership_payment_status_history: [],
  });
  const result = await applyStatusTransition({
    entityType: 'payment_plan', entityId: 'plan-1', toStatus: STATUS.ACTIVE,
  }, { db });
  assert.equal(result.applied, false);
  assert.equal(result.skippedReason, 'no-change');
  assert.equal(db.tables.membership_payment_status_history.length, 0);
});

test('applyStatusTransition rejects an out-of-order regression', async () => {
  const db = makeFakeDb({
    membership_payment_plans: [{ id: 'plan-1', tenant_id: TENANT, status: STATUS.ACTIVE }],
    membership_payment_status_history: [],
  });
  const result = await applyStatusTransition({
    entityType: 'payment_plan', entityId: 'plan-1', toStatus: STATUS.MANDATE_PENDING,
  }, { db });
  assert.equal(result.applied, false);
  assert.match(result.skippedReason, /invalid-transition/);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.ACTIVE);
});

test('applyStatusTransition handles missing rows gracefully', async () => {
  const db = makeFakeDb({ membership_payment_plans: [] });
  const result = await applyStatusTransition({
    entityType: 'payment_plan', entityId: 'nope', toStatus: STATUS.ACTIVE,
  }, { db });
  assert.equal(result.applied, false);
  assert.equal(result.skippedReason, 'row-not-found');
});

// ---------------------------------------------------------------------------
// processGocardlessEvent
// ---------------------------------------------------------------------------

function gcStub(overrides = {}) {
  return {
    getGocardlessEnvironment: () => 'sandbox',
    getBillingRequest: async () => { throw new Error('unexpected getBillingRequest'); },
    getMandate: async () => { throw new Error('unexpected getMandate'); },
    getSubscription: async () => { throw new Error('unexpected getSubscription'); },
    getPayment: async () => { throw new Error('unexpected getPayment'); },
    ...overrides,
  };
}

test('billing request fulfilled: attaches mandate/customer, agreement -> mandate_pending', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-1', tenant_id: TENANT, member_id: 'mem-1', organization_id: null,
      status: STATUS.PAYMENT_SETUP_REQUIRED, gocardless_billing_request_id: 'BRQ1',
    }],
    membership_payment_status_history: [],
    gocardless_customers: [],
    gocardless_mandates: [],
  });
  const event = {
    id: 'EV_BR1', resource_type: 'billing_requests', action: 'fulfilled',
    links: { billing_request: 'BRQ1', mandate_request_mandate: 'MD1', customer: 'CU1' },
  };
  const out = await processGocardlessEvent(event, { db, gc: gcStub() });
  assert.equal(out.handled, true);
  const agr = db.tables.membership_billing_agreements[0];
  assert.equal(agr.status, STATUS.MANDATE_PENDING);
  assert.equal(agr.gocardless_mandate_id, 'MD1');
  assert.equal(agr.gocardless_customer_id, 'CU1');
  assert.equal(db.tables.gocardless_customers.length, 1);
  assert.equal(db.tables.gocardless_mandates.length, 1);
});

test('duplicate delivery of the same event is a no-op (idempotent)', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-1', tenant_id: TENANT, status: STATUS.PAYMENT_SETUP_REQUIRED,
      gocardless_billing_request_id: 'BRQ1',
    }],
    membership_payment_status_history: [],
    gocardless_customers: [],
    gocardless_mandates: [],
  });
  const event = {
    id: 'EV_BR1', resource_type: 'billing_requests', action: 'fulfilled',
    links: { billing_request: 'BRQ1', mandate_request_mandate: 'MD1', customer: 'CU1' },
  };
  await processGocardlessEvent(event, { db, gc: gcStub() });
  await processGocardlessEvent(event, { db, gc: gcStub() });
  // History written only once; customers/mandates not duplicated.
  assert.equal(db.tables.membership_payment_status_history.length, 1);
  assert.equal(db.tables.gocardless_customers.length, 1);
  assert.equal(db.tables.gocardless_mandates.length, 1);
});

test('mandate active: agreement -> first_payment_pending, mandate mirror updated', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-1', tenant_id: TENANT, status: STATUS.MANDATE_PENDING,
      gocardless_billing_request_id: 'BRQ1', gocardless_mandate_id: 'MD1',
    }],
    gocardless_mandates: [{ id: 'gm-1', tenant_id: TENANT, gocardless_mandate_id: 'MD1', status: 'submitted' }],
    membership_payment_status_history: [],
  });
  const event = { id: 'EV_MD1', resource_type: 'mandates', action: 'active', links: { mandate: 'MD1' } };
  const out = await processGocardlessEvent(event, { db, gc: gcStub() });
  assert.equal(out.handled, true);
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.FIRST_PAYMENT_PENDING);
  assert.equal(db.tables.gocardless_mandates[0].status, 'active');
});

test('late mandate cancellation NOT confirmed by API leaves plan untouched', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-1', tenant_id: TENANT, status: STATUS.ACTIVE, gocardless_mandate_id: 'MD1',
    }],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: TENANT, status: STATUS.ACTIVE, gocardless_mandate_id: 'MD1',
    }],
    gocardless_mandates: [{ id: 'gm-1', tenant_id: TENANT, gocardless_mandate_id: 'MD1', status: 'active' }],
    membership_payment_status_history: [],
  });
  const event = { id: 'EV_MD2', resource_type: 'mandates', action: 'cancelled', links: { mandate: 'MD1' } };
  // API says the mandate is actually healthy — stale event.
  const out = await processGocardlessEvent(event, { db, gc: gcStub({ getMandate: async () => ({ status: 'active' }) }) });
  assert.equal(out.handled, true);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.ACTIVE);
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.ACTIVE);
});

test('mandate cancellation confirmed by API cancels agreement and plans', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-1', tenant_id: TENANT, status: STATUS.ACTIVE, gocardless_mandate_id: 'MD1',
    }],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: TENANT, status: STATUS.ACTIVE, gocardless_mandate_id: 'MD1',
    }],
    gocardless_mandates: [{ id: 'gm-1', tenant_id: TENANT, gocardless_mandate_id: 'MD1', status: 'active' }],
    membership_payment_status_history: [],
  });
  const event = { id: 'EV_MD3', resource_type: 'mandates', action: 'cancelled', links: { mandate: 'MD1' } };
  const out = await processGocardlessEvent(event, { db, gc: gcStub({ getMandate: async () => ({ status: 'cancelled' }) }) });
  assert.equal(out.handled, true);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_PLAN_CANCELLED);
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.PAYMENT_PLAN_CANCELLED);
  assert.equal(db.tables.membership_payment_status_history.length, 2);
});

test('payment confirmed: plan + agreement -> active, retry count reset, payment mirrored', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{ id: 'agr-1', tenant_id: TENANT, status: STATUS.FIRST_PAYMENT_PENDING }],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: TENANT, billing_agreement_id: 'agr-1',
      status: STATUS.FIRST_PAYMENT_PENDING, gocardless_subscription_id: 'SB1', retry_count: 1,
    }],
    gocardless_payments: [],
    membership_payment_status_history: [],
  });
  const event = {
    id: 'EV_PM1', resource_type: 'payments', action: 'confirmed',
    links: { payment: 'PM1', subscription: 'SB1' },
  };
  const out = await processGocardlessEvent(event, { db, gc: gcStub() });
  assert.equal(out.handled, true);
  const plan = db.tables.membership_payment_plans[0];
  assert.equal(plan.status, STATUS.ACTIVE);
  assert.equal(plan.retry_count, 0);
  assert.equal(plan.last_payment_id, 'PM1');
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.ACTIVE);
  assert.equal(db.tables.gocardless_payments.length, 1);
  assert.equal(db.tables.gocardless_payments[0].status, 'confirmed');
});

test('payment failures escalate: grace period first, overdue on repeat', async () => {
  const db = makeFakeDb({
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: TENANT, status: STATUS.ACTIVE,
      gocardless_subscription_id: 'SB1', retry_count: 0,
    }],
    gocardless_payments: [],
    membership_payment_status_history: [],
  });
  await processGocardlessEvent(
    { id: 'EV_F1', resource_type: 'payments', action: 'failed', links: { payment: 'PM1', subscription: 'SB1' } },
    { db, gc: gcStub() },
  );
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(db.tables.membership_payment_plans[0].retry_count, 1);
  await processGocardlessEvent(
    { id: 'EV_F2', resource_type: 'payments', action: 'failed', links: { payment: 'PM2', subscription: 'SB1' } },
    { db, gc: gcStub() },
  );
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_OVERDUE);
  assert.equal(db.tables.membership_payment_plans[0].retry_count, 2);
});

test('late out-of-order payment failed after recovery cannot regress active plan below grace', async () => {
  const db = makeFakeDb({
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: TENANT, status: STATUS.PAYMENT_PLAN_CANCELLED,
      gocardless_subscription_id: 'SB1', retry_count: 0,
    }],
    gocardless_payments: [],
    membership_payment_status_history: [],
  });
  const out = await processGocardlessEvent(
    { id: 'EV_F3', resource_type: 'payments', action: 'failed', links: { payment: 'PM3', subscription: 'SB1' } },
    { db, gc: gcStub() },
  );
  assert.equal(out.handled, true);
  // Terminal state preserved.
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_PLAN_CANCELLED);
});

test('subscription finished: plan -> expired', async () => {
  const db = makeFakeDb({
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: TENANT, status: STATUS.ACTIVE, gocardless_subscription_id: 'SB1',
    }],
    membership_payment_status_history: [],
  });
  const out = await processGocardlessEvent(
    { id: 'EV_SB1', resource_type: 'subscriptions', action: 'finished', links: { subscription: 'SB1' } },
    { db, gc: gcStub() },
  );
  assert.equal(out.handled, true);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.EXPIRED);
});

test('unknown resource types are ignored, not errors', async () => {
  const db = makeFakeDb({});
  const out = await processGocardlessEvent(
    { id: 'EV_X', resource_type: 'payouts', action: 'paid', links: {} },
    { db, gc: gcStub() },
  );
  assert.equal(out.handled, false);
});
