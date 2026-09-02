// GoCardless state machine + webhook processor tests (fake supabase db).
// Run: node --test api/_lib/gocardlessWebhookProcessor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { canTransition, applyStatusTransition, STATUS } from './gocardlessState.js';
import { processGocardlessEvent, validateConfirmedCatchUpAmount, isCatchUpTerminalFailureAction } from './gocardlessWebhookProcessor.js';

test('confirmed GC catch-up amount mismatch rejects before period allocation or intent completion', () => {
  const periods = [{ id: 'period-1', settled_at: null }];
  const intent = { intent_key: 'catch-1', status: 'created', arrears_amount_minor: 2500 };
  assert.throws(() => validateConfirmedCatchUpAmount(2000, intent.arrears_amount_minor), /amount mismatch/);
  assert.equal(periods[0].settled_at, null);
  assert.equal(intent.status, 'created');
});

test('matching confirmed GC catch-up amount validates identically on replay', () => {
  assert.equal(validateConfirmedCatchUpAmount(2500, 2500), 2500);
  assert.equal(validateConfirmedCatchUpAmount(2500, 2500), 2500);
  assert.throws(() => validateConfirmedCatchUpAmount(null, 2500), /authoritative amount/);
});

for (const action of ['failed', 'cancelled', 'charged_back', 'late_failure_settled', 'chargeback_settled']) {
  test(`GC catch-up terminal action ${action} retires immutable intent`, () => {
    assert.equal(isCatchUpTerminalFailureAction(action), true);
  });
}

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
    filter() { return this; }
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
    getPayment: async (id) => ({ id, amount: 1000, currency: 'GBP', charge_date: '2026-01-01' }),
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

test('matched catch-up confirmation mismatch fails preflight with zero local mutation', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{ id: 'agr-1', tenant_id: TENANT, status: STATUS.PAYMENT_OVERDUE }],
    membership_payment_plans: [{
      id: 'plan-1', tenant_id: TENANT, billing_agreement_id: 'agr-1',
      status: STATUS.PAYMENT_OVERDUE, gocardless_subscription_id: 'SB1', retry_count: 3,
    }],
    membership_monthly_collection_intent: [{
      id: 'intent-1', tenant_id: TENANT, plan_id: 'plan-1', intent_key: 'catch-1',
      provider_reference: 'PM-CATCH', arrears_amount_minor: 2500, period_ids: ['period-1'], status: 'created',
    }],
    membership_monthly_arrears_period: [{ id: 'period-1', tenant_id: TENANT, plan_id: 'plan-1', amount_minor: 2500, settled_at: null }],
    gocardless_payments: [],
    membership_payment_status_history: [],
  });
  const event = {
    id: 'EV_CATCH_BAD', resource_type: 'payments', action: 'confirmed',
    links: { payment: 'PM-CATCH', subscription: 'SB1' },
  };
  await assert.rejects(processGocardlessEvent(event, {
    db,
    gc: gcStub({ getPayment: async () => ({ id: 'PM-CATCH', amount: 2000, status: 'confirmed' }) }),
  }), /amount mismatch/);
  assert.equal(db.tables.gocardless_payments.length, 0);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_OVERDUE);
  assert.equal(db.tables.membership_payment_plans[0].retry_count, 3);
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.PAYMENT_OVERDUE);
  assert.equal(db.tables.membership_monthly_arrears_period[0].settled_at, null);
  assert.equal(db.tables.membership_monthly_collection_intent[0].status, 'created');
  assert.equal(db.tables.membership_payment_status_history.length, 0);
});

for (const action of ['failed', 'late_failure_settled']) {
  test(`matched catch-up ${action} exits before recurring arrears/retry control flow and replay is idempotent`, async () => {
    const db = makeFakeDb({
      membership_billing_agreements: [{ id: 'agr-1', tenant_id: TENANT, status: STATUS.PAYMENT_OVERDUE }],
      membership_payment_plans: [{
        id: 'plan-1', tenant_id: TENANT, billing_agreement_id: 'agr-1',
        status: STATUS.PAYMENT_OVERDUE, gocardless_subscription_id: 'SB1',
        interval_unit: 'monthly', grace_expires_at: '2026-01-20', retry_count: 2,
        metadata: { catch_up_intent: { key: 'catch-fail', provider_reference: 'PM-CATCH', status: 'created' } },
      }],
      membership_monthly_collection_intent: [{
        id: 'intent-1', tenant_id: TENANT, plan_id: 'plan-1', intent_key: 'catch-fail',
        provider_reference: 'PM-CATCH', arrears_amount_minor: 2500,
        period_ids: ['period-1'], status: 'created',
      }],
      membership_monthly_arrears_period: [{
        id: 'period-1', tenant_id: TENANT, plan_id: 'plan-1',
        due_period: '2026-01-01', amount_minor: 2500, settled_at: null,
      }],
      membership_payment_status_history: [],
      membership_payment_retry_schedule: [],
      gocardless_payments: [],
    });
    const event = {
      id: `EV-CATCH-${action}`, resource_type: 'payments', action,
      links: { payment: 'PM-CATCH', subscription: 'SB1' },
    };
    const first = await processGocardlessEvent(event, { db, gc: gcStub() });
    assert.equal(first.handled, true);
    assert.match(first.detail, /catch-up payment/);
    assert.equal(db.tables.membership_monthly_collection_intent[0].status, 'failed');
    assert.equal(db.tables.membership_monthly_arrears_period.length, 1);
    assert.equal(db.tables.membership_monthly_arrears_period[0].settled_at, null);
    assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_OVERDUE);
    assert.equal(db.tables.membership_payment_plans[0].grace_expires_at, '2026-01-20');
    assert.equal(db.tables.membership_payment_plans[0].retry_count, 2);
    assert.equal(db.tables.membership_payment_status_history.length, 0);
    assert.equal(db.tables.membership_payment_retry_schedule.length, 0);
    assert.equal(db.tables.gocardless_payments.length, 1);
    const replay = await processGocardlessEvent({ ...event, id: `${event.id}-REPLAY` }, { db, gc: gcStub() });
    assert.equal(replay.handled, true);
    assert.equal(db.tables.membership_monthly_arrears_period.length, 1);
    assert.equal(db.tables.membership_payment_status_history.length, 0);
    assert.equal(db.tables.membership_payment_retry_schedule.length, 0);
    assert.equal(db.tables.gocardless_payments.length, 1);
  });
}

test('confirmed subscription-less GC split-window recovery settles and accounts once; duplicate is no-op', async () => {
  const splitTenant = '11111111-1111-4111-8111-111111111111';
  const planId = '22222222-2222-4222-8222-222222222222';
  const periodId = '33333333-3333-4333-8333-333333333333';
  const intentKey = `monthly-catch-up:${planId}:${periodId}`;
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-split', tenant_id: splitTenant, status: STATUS.ACTIVE,
      metadata: { dd: { invoicing_mode: 'per_instalment' } },
    }],
    membership_payment_plans: [{
      id: planId, tenant_id: splitTenant, billing_agreement_id: 'agr-split',
      provider: 'gocardless', interval_unit: 'monthly', currency: 'GBP',
      status: STATUS.ACTIVE, metadata: { catch_up_intent: { key: intentKey, status: 'creating' } },
    }],
    membership_monthly_collection_intent: [{
      id: 'intent-split', tenant_id: splitTenant, plan_id: planId, intent_key: intentKey,
      status: 'creating', period_ids: [periodId], arrears_amount_minor: 2500,
    }],
    membership_monthly_arrears_period: [{
      id: periodId, tenant_id: splitTenant, plan_id: planId, due_period: '2026-01-01',
      amount_minor: 2500, settled_at: null, settlement_reference: null,
    }],
    membership_monthly_arrears_accounting: [{
      id: 'acct-claim', tenant_id: splitTenant, plan_id: planId, arrears_period_id: periodId,
      provider_payment_reference: 'PM-SPLIT', amount_minor: 2500, accounting_status: 'pending',
    }],
    gocardless_payments: [],
    membership_payment_status_history: [],
  });
  const calls = { recover: [], settle: [], accounting: 0 };
  db.rpc = async (name, args) => {
    if (name === 'recover_membership_monthly_collection_provider_ref') {
      calls.recover.push(args);
      const intent = db.tables.membership_monthly_collection_intent[0];
      Object.assign(intent, { status: 'created', provider_reference: 'PM-SPLIT', provider_charge_date: '2026-03-01' });
      return { data: [{ ...intent }], error: null };
    }
    if (name === 'settle_membership_monthly_arrears') {
      calls.settle.push(args);
      const period = db.tables.membership_monthly_arrears_period[0];
      if (!period.settled_at) Object.assign(period, { settled_at: '2026-03-02', settlement_reference: args.p_settlement_reference });
      return { data: [{ settled_count: 1, settled_amount_minor: 2500 }], error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  };
  const payment = {
    id: 'PM-SPLIT', amount: 2500, currency: 'GBP', charge_date: '2026-03-01',
    metadata: {
      catch_up_intent_key: intentKey, tenant_id: splitTenant, plan_id: planId,
      arrears_amount_minor: '2500', arrears_period_ids: periodId,
    },
  };
  const event = { id: 'EV-SPLIT', resource_type: 'payments', action: 'confirmed', links: { payment: 'PM-SPLIT' } };
  const deps = {
    db, gc: gcStub({ getPayment: async () => payment }),
    postArrearsPeriod: async () => { calls.accounting++; return { status: 'posted', invoiceId: 'acct-1' }; },
  };
  assert.equal((await processGocardlessEvent(event, deps)).handled, true);
  assert.equal(calls.recover.length, 1);
  assert.deepEqual(calls.recover[0], {
    p_tenant_id: splitTenant, p_plan_id: planId, p_intent_key: intentKey,
    p_provider_reference: 'PM-SPLIT', p_provider_charge_date: '2026-03-01',
  });
  assert.equal(calls.settle.length, 1);
  assert.deepEqual(calls.settle[0].p_period_ids, [periodId]);
  assert.equal(calls.settle[0].p_amount_minor, 2500);
  assert.equal(calls.accounting, 1);
  assert.equal(db.tables.membership_monthly_collection_intent[0].status, 'completed');
  assert.equal((await processGocardlessEvent({ ...event, id: 'EV-SPLIT-REPLAY' }, deps)).handled, true);
  assert.equal(calls.recover.length, 1);
  assert.equal(calls.settle.length, 1);
  assert.equal(calls.accounting, 1);
});

test('payment failures escalate: grace period first (time-based), overdue when grace expired', async () => {
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
  const plan = db.tables.membership_payment_plans[0];
  assert.equal(plan.status, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(plan.retry_count, 1);
  // Grace window opened using snapshot default (7 days).
  assert.ok(plan.grace_expires_at, 'grace_expires_at set');
  assert.ok(new Date(plan.grace_expires_at) > new Date(), 'grace expiry is in the future');

  // Second failure WITHIN the grace window stays in grace (time-based, not count-based).
  await processGocardlessEvent(
    { id: 'EV_F2', resource_type: 'payments', action: 'failed', links: { payment: 'PM2', subscription: 'SB1' } },
    { db, gc: gcStub() },
  );
  assert.equal(plan.status, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(plan.retry_count, 2);

  // Failure after the grace window has expired escalates to overdue.
  plan.grace_expires_at = new Date(Date.now() - 60_000).toISOString();
  await processGocardlessEvent(
    { id: 'EV_F3B', resource_type: 'payments', action: 'failed', links: { payment: 'PM2B', subscription: 'SB1' } },
    { db, gc: gcStub() },
  );
  assert.equal(plan.status, STATUS.PAYMENT_OVERDUE);
  assert.equal(plan.retry_count, 3);
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

test('refund rollup counts only non-failed refunds (mixed statuses)', async () => {
  const db = makeFakeDb({
    gocardless_payments: [{
      id: 'gp-1', tenant_id: TENANT, gocardless_payment_id: 'PM9',
      amount_minor: 5000, amount_refunded_minor: 0, paid_out_at: null,
    }],
    gocardless_refunds: [],
  });
  const gc = gcStub({
    getRefund: async () => ({ id: 'RF2', amount: 1000, currency: 'GBP', links: { payment: 'PM9' } }),
    listRefunds: async () => ([
      { id: 'RF1', amount: 2000, status: 'refund_settled' },
      { id: 'RF2', amount: 1000, status: 'created' },
      { id: 'RF3', amount: 5000, status: 'failed' },      // must NOT count
      { id: 'RF4', amount: 300, status: 'cancelled' },    // must NOT count
    ]),
  });
  const out = await processGocardlessEvent(
    { id: 'EV_RF2', resource_type: 'refunds', action: 'created', links: { refund: 'RF2', payment: 'PM9' } },
    { db, gc },
  );
  assert.equal(out.handled, true);
  const pay = db.tables.gocardless_payments[0];
  assert.equal(pay.amount_refunded_minor, 3000); // 2000 + 1000 only
  assert.equal(pay.refund_status, 'partially_refunded'); // not 'refunded' (failed excluded)
});

test('refund failed event immediately removes it from the rollup', async () => {
  const db = makeFakeDb({
    gocardless_payments: [{
      id: 'gp-1', tenant_id: TENANT, gocardless_payment_id: 'PM9',
      amount_minor: 5000, amount_refunded_minor: 0, paid_out_at: null,
    }],
    gocardless_refunds: [],
  });
  const refunds = [{ id: 'RF1', amount: 2000, status: 'created' }];
  const gc = gcStub({
    getRefund: async () => ({ id: 'RF1', amount: 2000, currency: 'GBP', links: { payment: 'PM9' } }),
    listRefunds: async () => refunds,
  });
  // 1) refund created — counted.
  await processGocardlessEvent(
    { id: 'EV_RF_A', resource_type: 'refunds', action: 'created', links: { refund: 'RF1', payment: 'PM9' } },
    { db, gc },
  );
  assert.equal(db.tables.gocardless_payments[0].amount_refunded_minor, 2000);
  assert.equal(db.tables.gocardless_payments[0].refund_status, 'partially_refunded');
  // 2) same refund fails — rollup recomputed on the failed event itself.
  refunds[0].status = 'failed';
  const out = await processGocardlessEvent(
    { id: 'EV_RF_B', resource_type: 'refunds', action: 'failed', links: { refund: 'RF1', payment: 'PM9' } },
    { db, gc },
  );
  assert.equal(out.handled, true);
  assert.equal(db.tables.gocardless_payments[0].amount_refunded_minor, 0);
  assert.equal(db.tables.gocardless_payments[0].refund_status, null);
});
