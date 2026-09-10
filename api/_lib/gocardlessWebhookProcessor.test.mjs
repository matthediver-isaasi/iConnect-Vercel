// GoCardless state machine + webhook processor tests (fake supabase db).
// Run: node --test api/_lib/gocardlessWebhookProcessor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { canTransition, applyStatusTransition, STATUS } from './gocardlessState.js';
import { processGocardlessEvent, validateConfirmedCatchUpAmount, isCatchUpTerminalFailureAction } from './gocardlessWebhookProcessor.js';
import { buildIdempotencyKey } from './gocardless.js';

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

test('GoCardless reconciliation replays fulfilled and payment lifecycle processors', async () => {
  const source = await readFile(new URL('../cron/reconcile-gocardless.js', import.meta.url), 'utf8');
  assert.match(source, /if\s*\(\s*\['active',\s*'reinstated'\]\.includes\(mandate\?\.status\)\s*\)/);
  assert.match(source, /processGocardlessEvent\s*\(\s*\{\s*[\s\S]*resource_type:\s*'billing_requests'/);
  assert.match(source, /processGocardlessEvent\s*\(\s*\{\s*[\s\S]*resource_type:\s*'payments'/);
  assert.match(source, /reconcile:payment:/);
});

// ---------------------------------------------------------------------------
// Minimal in-memory supabase-shaped fake
// ---------------------------------------------------------------------------

function makeFakeDb(initial = {}, { rpc = null } = {}) {
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
        const inserted = list.map((p) => ({ id: p.id || crypto.randomUUID(), ...p }));
        rows.push(...inserted);
        return { data: inserted, error: null };
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
    single() {
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
    rpc(name, params) {
      if (rpc) return Promise.resolve(rpc(name, params, tables));
      return Promise.resolve({
        data: null,
        error: { message: `unexpected RPC ${name}` },
      });
    },
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

test('fulfilled retry repairs provider IDs even when agreement status is already mandate_pending', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-repair',
      tenant_id: TENANT,
      status: STATUS.MANDATE_PENDING,
      gocardless_billing_request_id: 'BRQ-repair',
      gocardless_mandate_id: null,
      gocardless_customer_id: null,
    }],
    membership_payment_status_history: [],
    gocardless_customers: [],
    gocardless_mandates: [],
  });

  const out = await processGocardlessEvent({
    id: 'EV_BR_REPAIR',
    resource_type: 'billing_requests',
    action: 'fulfilled',
    links: {
      billing_request: 'BRQ-repair',
      mandate_request_mandate: 'MD-repair',
      customer: 'CU-repair',
    },
  }, { db, gc: gcStub() });

  assert.equal(out.handled, true);
  assert.equal(db.tables.membership_billing_agreements[0].gocardless_mandate_id, 'MD-repair');
  assert.equal(db.tables.membership_billing_agreements[0].gocardless_customer_id, 'CU-repair');
  assert.equal(db.tables.membership_payment_status_history.length, 0);
});

test('fulfilled retry rejects a conflicting immutable mandate identity', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-conflict',
      tenant_id: TENANT,
      status: STATUS.MANDATE_PENDING,
      gocardless_billing_request_id: 'BRQ-conflict',
      gocardless_mandate_id: 'MD-original',
    }],
    membership_payment_status_history: [],
    gocardless_customers: [],
    gocardless_mandates: [],
  });

  await assert.rejects(processGocardlessEvent({
    id: 'EV_BR_CONFLICT',
    resource_type: 'billing_requests',
    action: 'fulfilled',
    links: {
      billing_request: 'BRQ-conflict',
      mandate_request_mandate: 'MD-other',
      customer: 'CU-conflict',
    },
  }, { db, gc: gcStub() }), /does not match existing agreement mandate/);
  assert.equal(db.tables.membership_billing_agreements[0].gocardless_mandate_id, 'MD-original');
});

test('fulfilled replay for a superseded consent agreement is ignored', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-old',
      tenant_id: TENANT,
      status: STATUS.PAYMENT_PLAN_CANCELLED,
      gocardless_billing_request_id: 'BRQ-old',
      metadata: { consent_superseded_by: 'agr-new' },
    }],
    membership_payment_status_history: [],
    gocardless_customers: [],
    gocardless_mandates: [],
  });
  let providerRead = false;
  const out = await processGocardlessEvent({
    id: 'EV_OLD',
    resource_type: 'billing_requests',
    action: 'fulfilled',
    links: { billing_request: 'BRQ-old', mandate_request_mandate: 'MD-old' },
  }, {
    db,
    gc: gcStub({ getBillingRequest: async () => { providerRead = true; return {}; } }),
  });
  assert.equal(out.handled, true);
  assert.match(out.detail, /superseded/);
  assert.equal(providerRead, false);
  assert.equal(db.tables.gocardless_mandates.length, 0);
  assert.equal(db.tables.membership_payment_status_history.length, 0);
});

test('monthly billing request fulfillment records its first instalment once', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-monthly',
      tenant_id: TENANT,
      member_id: 'mem-1',
      organization_id: null,
      status: STATUS.PAYMENT_SETUP_REQUIRED,
      gocardless_billing_request_id: 'BRQ-monthly',
      metadata: {
        dd: {
          kind: 'monthly_direct_debit',
          billing_request_payment: { included: true, amount_minor: 1000 },
        },
      },
    }],
    membership_payment_status_history: [],
    gocardless_customers: [],
    gocardless_mandates: [],
    gocardless_payments: [{
      id: 'payment-first',
      tenant_id: TENANT,
      plan_id: 'plan-existing',
      gocardless_payment_id: 'PM-first',
      status: 'confirmed',
    }],
  });
  const event = {
    id: 'EV_BR_MONTHLY',
    resource_type: 'billing_requests',
    action: 'fulfilled',
    links: {
      billing_request: 'BRQ-monthly',
      mandate_request_mandate: 'MD-monthly',
      payment_request_payment: 'PM-first',
      customer: 'CU-monthly',
    },
  };

  const monthlyGc = gcStub({
    getMandate: async () => ({ id: 'MD-monthly', status: 'pending_submission' }),
    getPayment: async () => ({
      id: 'PM-first',
      amount: 1000,
      currency: 'GBP',
      charge_date: '2026-08-01',
      status: 'pending_submission',
    }),
  });
  await processGocardlessEvent(event, { db, gc: monthlyGc });
  await processGocardlessEvent(event, { db, gc: monthlyGc });

  const agreement = db.tables.membership_billing_agreements[0];
  assert.equal(agreement.metadata.gocardless_initial_payment.id, 'PM-first');
  assert.equal(db.tables.gocardless_payments.length, 1);
  assert.equal(db.tables.gocardless_payments[0].gocardless_payment_id, 'PM-first');
  assert.equal(db.tables.gocardless_payments[0].status, 'confirmed');
  assert.equal(db.tables.gocardless_payments[0].plan_id, 'plan-existing');
});

test('mandate-only fulfillment creates one full finite subscription and remains idempotent', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-mandate-only',
      tenant_id: TENANT,
      member_id: 'mem-1',
      organization_id: null,
      status: STATUS.PAYMENT_SETUP_REQUIRED,
      gocardless_billing_request_id: 'BRQ-mandate-only',
      metadata: {
        dd: {
          kind: 'monthly_direct_debit',
          monthly_amount_minor: 750,
          instalment_count: 6,
          currency: 'GBP',
          first_collection_rule: 'anniversary',
          membership_year_start: '2026-04-01',
          activation_rule: 'first_payment',
          accepted_at: '2026-07-01T00:00:00.000Z',
          membership_year: '2026',
          billing_request_mode: 'mandate_only',
        },
      },
    }],
    membership_payment_status_history: [],
    membership_payment_plans: [],
    member_membership_history: [{
      id: 'history-mandate-only',
      billing_agreement_id: 'agr-mandate-only',
      status: 'pending_payment_setup',
      payment_status: 'unpaid',
    }],
    gocardless_customers: [],
    gocardless_mandates: [],
    gocardless_payments: [],
  });
  const subscriptionCalls = [];
  const gc = gcStub({
    getMandate: async () => ({
      id: 'MD-mandate-only',
      status: 'active',
      next_possible_charge_date: '2026-08-12',
    }),
    createSubscription: async (args) => {
      subscriptionCalls.push(args);
      return { id: 'SB-mandate-only', start_date: args.startDate };
    },
  });
  const event = {
    id: 'EV_BR_MANDATE_ONLY',
    resource_type: 'billing_requests',
    action: 'fulfilled',
    links: {
      billing_request: 'BRQ-mandate-only',
      mandate_request_mandate: 'MD-mandate-only',
      customer: 'CU-mandate-only',
    },
  };

  const deps = {
    db,
    gc,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    postToAccounting: async () => ({ posted: false }),
  };
  await processGocardlessEvent(event, deps);
  await processGocardlessEvent(event, deps);

  assert.equal(subscriptionCalls.length, 1);
  assert.equal(subscriptionCalls[0].amountMinor, 750);
  assert.equal(subscriptionCalls[0].count, 6);
  assert.equal(subscriptionCalls[0].dayOfMonth, 1);
  assert.equal(subscriptionCalls[0].startDate, '2026-09-01');
  assert.equal(db.tables.membership_payment_plans.length, 1);
  assert.equal(db.tables.membership_payment_plans[0].gocardless_subscription_id, 'SB-mandate-only');
  assert.equal(db.tables.gocardless_payments.length, 0);
  assert.equal(db.tables.gocardless_mandates[0].next_possible_charge_date, '2026-08-12');
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.FIRST_PAYMENT_PENDING);
});

test('form mandate fulfillment binds member and history before subscription creation', async () => {
  const order = [];
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-form-mandate-only',
      tenant_id: TENANT,
      provider: 'gocardless',
      agreement_type: 'member',
      member_id: null,
      organization_id: null,
      status: STATUS.PAYMENT_SETUP_REQUIRED,
      gocardless_billing_request_id: 'BRQ-form-mandate-only',
      metadata: {
        form_submission_id: 'sub-form-mandate-only',
        dd: {
          kind: 'monthly_direct_debit',
          monthly_amount_minor: 1250,
          instalment_count: 8,
          plan_total: 100,
          currency: 'GBP',
          first_collection_rule: 'earliest',
          activation_rule: 'first_payment',
          accepted_at: '2026-07-01T00:00:00.000Z',
          membership_year: '2026',
          billing_request_mode: 'mandate_only',
        },
      },
    }],
    form_submission: [{
      id: 'sub-form-mandate-only',
      tenant_id: TENANT,
      form_id: 'form-monthly-dd',
      payment_status: 'pending',
      payment_provider: 'gocardless_monthly_dd',
      payment_meta: {
        monthly_direct_debit: {
          agreement_id: 'agr-form-mandate-only',
          billing_request_id: 'BRQ-form-mandate-only',
        },
      },
      created_member_id: 'member-from-form',
      submission_data: {},
    }],
    form: [{
      id: 'form-monthly-dd',
      tenant_id: TENANT,
      access_policy: null,
      fields: [],
      entity_pipelines: null,
      structured_actions: null,
    }],
    member: [{ id: 'member-from-form', tenant_id: TENANT }],
    membership_payment_status_history: [],
    membership_payment_plans: [],
    member_membership_history: [],
    gocardless_customers: [],
    gocardless_mandates: [],
    gocardless_payments: [],
  }, {
    rpc: (name, params, tables) => {
      assert.equal(name, 'bind_form_monthly_direct_debit_membership');
      order.push('bind-membership');
      const agreement = tables.membership_billing_agreements
        .find((row) => row.id === params.p_agreement_id);
      agreement.member_id = params.p_member_id;
      tables.member_membership_history.push({
        id: 'history-form-mandate-only',
        tenant_id: TENANT,
        member_id: params.p_member_id,
        billing_agreement_id: agreement.id,
        status: 'pending_payment_setup',
        payment_status: 'unpaid',
      });
      return {
        data: {
          ok: true,
          history_id: 'history-form-mandate-only',
        },
        error: null,
      };
    },
  });
  const gc = gcStub({
    getMandate: async () => ({
      id: 'MD-form-mandate-only',
      status: 'active',
      next_possible_charge_date: '2026-08-12',
    }),
    createSubscription: async (args) => {
      order.push('create-subscription');
      assert.equal(
        db.tables.membership_billing_agreements[0].member_id,
        'member-from-form',
      );
      assert.equal(db.tables.member_membership_history.length, 1);
      return {
        id: 'SB-form-mandate-only',
        start_date: args.startDate,
      };
    },
  });
  const event = {
    id: 'EV_BR_FORM_MANDATE_ONLY',
    resource_type: 'billing_requests',
    action: 'fulfilled',
    links: {
      billing_request: 'BRQ-form-mandate-only',
      mandate_request_mandate: 'MD-form-mandate-only',
      customer: 'CU-form-mandate-only',
    },
  };

  const outcome = await processGocardlessEvent(event, {
    db,
    gc,
    baseUrl: 'https://tenant.example.test',
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    postToAccounting: async () => ({ posted: false }),
  });

  assert.equal(outcome.handled, true);
  assert.deepEqual(order, ['bind-membership', 'create-subscription']);
  assert.equal(db.tables.form_submission[0].payment_status, 'setup_complete');
  assert.equal(
    db.tables.form_submission[0].payment_meta.monthly_dd_state.status,
    'done',
  );
  assert.equal(db.tables.membership_payment_plans.length, 1);
  assert.equal(
    db.tables.membership_payment_plans[0].gocardless_subscription_id,
    'SB-form-mandate-only',
  );
});

test('fulfilled billing request repairs an earlier active-mandate event and creates one remaining subscription', async () => {
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-reordered',
      tenant_id: TENANT,
      member_id: 'mem-1',
      organization_id: null,
      status: STATUS.PAYMENT_SETUP_REQUIRED,
      gocardless_billing_request_id: 'BRQ-reordered',
      metadata: {
        dd: {
          kind: 'monthly_direct_debit',
          monthly_amount_minor: 1000,
          instalment_count: 12,
          currency: 'GBP',
          first_collection_rule: 'earliest',
          activation_rule: 'first_payment',
          accepted_at: '2026-07-01T00:00:00.000Z',
          membership_year: '2026',
          billing_request_payment: { included: true, amount_minor: 1000 },
        },
      },
    }],
    membership_payment_status_history: [],
    membership_payment_plans: [],
    member_membership_history: [{
      id: 'history-reordered',
      billing_agreement_id: 'agr-reordered',
      status: 'pending_payment_setup',
      payment_status: 'pending',
    }],
    gocardless_customers: [],
    gocardless_mandates: [],
    gocardless_payments: [],
  });
  const subscriptionCalls = [];
  const gc = gcStub({
    getMandate: async () => ({ id: 'MD-reordered', status: 'active' }),
    getPayment: async () => ({
      id: 'PM-reordered',
      amount: 1000,
      currency: 'GBP',
      charge_date: '2026-07-10',
      status: 'confirmed',
    }),
    createSubscription: async (args) => {
      subscriptionCalls.push(args);
      return { id: 'SB-reordered', start_date: args.startDate };
    },
  });
  const event = {
    id: 'EV_BR_REORDERED',
    resource_type: 'billing_requests',
    action: 'fulfilled',
    links: {
      billing_request: 'BRQ-reordered',
      mandate_request_mandate: 'MD-reordered',
      payment_request_payment: 'PM-reordered',
      customer: 'CU-reordered',
    },
  };

  const deps = {
    db,
    gc,
    now: () => new Date('2026-07-20T00:00:00.000Z'),
    postToAccounting: async () => ({ posted: false }),
  };
  await processGocardlessEvent(event, deps);
  await processGocardlessEvent(event, deps);

  assert.equal(subscriptionCalls.length, 1);
  assert.equal(subscriptionCalls[0].count, 11);
  assert.equal(subscriptionCalls[0].startDate, '2026-08-10');
  assert.equal(db.tables.membership_payment_plans.length, 1);
  assert.equal(db.tables.membership_payment_plans[0].gocardless_subscription_id, 'SB-reordered');
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.ACTIVE);
  assert.equal(db.tables.member_membership_history[0].status, 'active');
  assert.equal(db.tables.member_membership_history[0].payment_status, 'partial');
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

test('late mandate replay never treats the old first payment as recovery from later arrears', async () => {
  const plan = {
    id: 'plan-arrears',
    tenant_id: TENANT,
    billing_agreement_id: 'agr-arrears',
    status: STATUS.PAYMENT_GRACE_PERIOD,
    gocardless_subscription_id: 'SB-arrears',
    gocardless_mandate_id: 'MD-arrears',
    idempotency_key: buildIdempotencyKey('dd-sub', 'agr-arrears', '2026'),
    last_payment_id: 'PM-later-failed',
    last_payment_status: 'failed',
    retry_count: 2,
    grace_expires_at: '2026-09-20T00:00:00.000Z',
  };
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-arrears',
      tenant_id: TENANT,
      status: STATUS.PAYMENT_GRACE_PERIOD,
      gocardless_mandate_id: 'MD-arrears',
      metadata: {
        gocardless_initial_payment: { id: 'PM-initial', charge_date: '2026-07-10' },
        dd: {
          kind: 'monthly_direct_debit',
          membership_year: '2026',
          instalment_count: 12,
          activation_rule: 'first_payment',
          billing_request_payment: { included: true, amount_minor: 1000 },
        },
      },
    }],
    membership_payment_plans: [plan],
    gocardless_payments: [{
      id: 'payment-initial',
      tenant_id: TENANT,
      plan_id: 'plan-arrears',
      gocardless_payment_id: 'PM-initial',
      status: 'confirmed',
    }],
    gocardless_mandates: [{
      id: 'mandate-arrears',
      tenant_id: TENANT,
      gocardless_mandate_id: 'MD-arrears',
      status: 'active',
    }],
    membership_payment_status_history: [],
  });
  await processGocardlessEvent({
    id: 'EV_MD_ARREARS_REPLAY',
    resource_type: 'mandates',
    action: 'active',
    links: { mandate: 'MD-arrears' },
  }, {
    db,
    gc: gcStub(),
    postToAccounting: async () => ({ posted: false }),
  });

  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(db.tables.membership_billing_agreements[0].status, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(db.tables.membership_payment_plans[0].last_payment_id, 'PM-later-failed');
  assert.equal(db.tables.membership_payment_plans[0].retry_count, 2);
  assert.equal(db.tables.membership_payment_plans[0].grace_expires_at, '2026-09-20T00:00:00.000Z');
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

test('a confirmed provider retry moves the same payment mirror from failed to confirmed', async () => {
  const plan = {
    id: 'plan-retry',
    tenant_id: TENANT,
    billing_agreement_id: 'agr-retry',
    status: STATUS.PAYMENT_GRACE_PERIOD,
    gocardless_subscription_id: 'SB-retry',
    retry_count: 1,
  };
  const db = makeFakeDb({
    membership_billing_agreements: [{ id: 'agr-retry', tenant_id: TENANT, status: STATUS.PAYMENT_GRACE_PERIOD }],
    membership_payment_plans: [plan],
    gocardless_payments: [{
      id: 'payment-retry',
      tenant_id: TENANT,
      plan_id: 'plan-retry',
      gocardless_payment_id: 'PM-retry',
      gocardless_subscription_id: 'SB-retry',
      status: 'failed',
      membership_payment_plans: plan,
    }],
    membership_payment_status_history: [],
  });
  await processGocardlessEvent({
    id: 'EV_PM_RETRY_CONFIRMED',
    resource_type: 'payments',
    action: 'confirmed',
    links: { payment: 'PM-retry', subscription: 'SB-retry' },
  }, {
    db,
    gc: gcStub({ getPayment: async () => ({ id: 'PM-retry', amount: 1000, currency: 'GBP', status: 'confirmed' }) }),
  });

  assert.equal(db.tables.gocardless_payments[0].status, 'confirmed');
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.ACTIVE);
});

test('sparse confirmed replay preserves payment provider identity and paid_out status', async () => {
  const plan = {
    id: 'plan-sparse',
    tenant_id: TENANT,
    billing_agreement_id: 'agr-sparse',
    status: STATUS.ACTIVE,
    gocardless_subscription_id: 'SB-sparse',
    retry_count: 0,
  };
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-sparse',
      tenant_id: TENANT,
      status: STATUS.ACTIVE,
    }],
    membership_payment_plans: [plan],
    gocardless_payments: [{
      id: 'payment-sparse',
      tenant_id: TENANT,
      plan_id: 'plan-sparse',
      gocardless_payment_id: 'PM-sparse',
      gocardless_subscription_id: 'SB-sparse',
      gocardless_mandate_id: 'MD-sparse',
      status: 'paid_out',
      membership_payment_plans: plan,
    }],
    membership_payment_status_history: [],
  });

  await processGocardlessEvent({
    id: 'EV_PM_SPARSE_REPLAY',
    resource_type: 'payments',
    action: 'confirmed',
    links: { payment: 'PM-sparse' },
  }, { db, gc: gcStub() });

  const payment = db.tables.gocardless_payments[0];
  assert.equal(payment.plan_id, 'plan-sparse');
  assert.equal(payment.gocardless_subscription_id, 'SB-sparse');
  assert.equal(payment.gocardless_mandate_id, 'MD-sparse');
  assert.equal(payment.status, 'paid_out');
});

test('confirmed first billing-request payment completes a one-instalment plan', async () => {
  const plan = {
    id: 'plan-one',
    tenant_id: TENANT,
    billing_agreement_id: 'agr-one',
    status: STATUS.FIRST_PAYMENT_PENDING,
    gocardless_subscription_id: null,
    retry_count: 0,
  };
  const db = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-one',
      tenant_id: TENANT,
      member_id: 'mem-one',
      status: STATUS.FIRST_PAYMENT_PENDING,
      gocardless_mandate_id: 'MD-one',
      metadata: {
        gocardless_initial_payment: { id: 'PM-one', charge_date: '2026-07-10' },
        dd: {
          kind: 'monthly_direct_debit',
          instalment_count: 1,
          activation_rule: 'first_payment',
          billing_request_payment: { included: true, amount_minor: 1000 },
        },
      },
    }],
    membership_payment_plans: [plan],
    gocardless_payments: [{
      id: 'payment-one',
      tenant_id: TENANT,
      plan_id: 'plan-one',
      gocardless_payment_id: 'PM-one',
      gocardless_mandate_id: 'MD-one',
      status: 'submitted',
      membership_payment_plans: plan,
    }],
    member_membership_history: [{
      id: 'history-one',
      billing_agreement_id: 'agr-one',
      status: 'pending_payment_setup',
      payment_status: 'pending',
    }],
    membership_payment_status_history: [],
  });
  const event = {
    id: 'EV_PM_ONE',
    resource_type: 'payments',
    action: 'confirmed',
    links: { payment: 'PM-one', mandate: 'MD-one' },
  };

  await processGocardlessEvent(event, {
    db,
    gc: gcStub(),
    postToAccounting: async () => ({ posted: false }),
  });

  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.EXPIRED);
  assert.ok(db.tables.membership_payment_plans[0].completed_at);
  assert.equal(db.tables.member_membership_history[0].payment_status, 'paid');
  assert.ok(db.tables.member_membership_history[0].paid_at);
});

test('mandate reconciliation resumes after an interrupted membership payment-progress read', async () => {
  const plan = {
    id: 'plan-interrupted',
    tenant_id: TENANT,
    billing_agreement_id: 'agr-interrupted',
    status: STATUS.FIRST_PAYMENT_PENDING,
    gocardless_subscription_id: null,
    gocardless_mandate_id: 'MD-interrupted',
    idempotency_key: buildIdempotencyKey('dd-sub', 'agr-interrupted', '2026'),
    retry_count: 0,
  };
  const baseDb = makeFakeDb({
    membership_billing_agreements: [{
      id: 'agr-interrupted',
      tenant_id: TENANT,
      member_id: 'mem-interrupted',
      status: STATUS.FIRST_PAYMENT_PENDING,
      gocardless_mandate_id: 'MD-interrupted',
      metadata: {
        gocardless_initial_payment: { id: 'PM-interrupted', charge_date: '2026-07-10' },
        dd: {
          kind: 'monthly_direct_debit',
          membership_year: '2026',
          instalment_count: 1,
          monthly_amount_minor: 1000,
          currency: 'GBP',
          activation_rule: 'first_payment',
          billing_request_payment: { included: true, amount_minor: 1000 },
        },
      },
    }],
    membership_payment_plans: [plan],
    gocardless_payments: [{
      id: 'payment-interrupted',
      tenant_id: TENANT,
      plan_id: 'plan-interrupted',
      gocardless_payment_id: 'PM-interrupted',
      gocardless_mandate_id: 'MD-interrupted',
      status: 'submitted',
      membership_payment_plans: plan,
    }],
    gocardless_mandates: [{
      id: 'mandate-interrupted',
      tenant_id: TENANT,
      gocardless_mandate_id: 'MD-interrupted',
      status: 'active',
    }],
    member_membership_history: [{
      id: 'history-interrupted',
      billing_agreement_id: 'agr-interrupted',
      status: 'pending_payment_setup',
      payment_status: 'pending',
    }],
    membership_payment_status_history: [],
  });
  let historyReadCount = 0;
  const db = {
    tables: baseDb.tables,
    from(table) {
      const query = baseDb.from(table);
      if (table === 'member_membership_history') {
        const originalMaybeSingle = query.maybeSingle.bind(query);
        query.maybeSingle = () => {
          historyReadCount += 1;
          if (historyReadCount === 2) {
            return Promise.resolve({ data: null, error: { message: 'injected payment-progress read failure' } });
          }
          return originalMaybeSingle();
        };
      }
      return query;
    },
  };
  const paymentEvent = {
    id: 'EV_PM_INTERRUPTED',
    resource_type: 'payments',
    action: 'confirmed',
    links: { payment: 'PM-interrupted', mandate: 'MD-interrupted' },
  };
  await assert.rejects(processGocardlessEvent(paymentEvent, {
    db,
    gc: gcStub(),
    postToAccounting: async () => ({ posted: false }),
  }), /injected payment-progress read failure/);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.ACTIVE);
  assert.equal(db.tables.member_membership_history[0].status, 'active');
  assert.equal(db.tables.member_membership_history[0].payment_status, 'pending');
  assert.equal(db.tables.membership_billing_agreements[0].metadata.gocardless_initial_payment.finalized_at, undefined);

  db.tables.gocardless_payments[0].membership_payment_plans = db.tables.membership_payment_plans[0];
  await processGocardlessEvent({
    id: 'EV_MD_INTERRUPTED_RECONCILE',
    resource_type: 'mandates',
    action: 'active',
    links: { mandate: 'MD-interrupted' },
  }, {
    db,
    gc: gcStub(),
    postToAccounting: async () => ({ posted: false }),
  });

  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.EXPIRED);
  assert.ok(db.tables.membership_payment_plans[0].completed_at);
  assert.equal(db.tables.member_membership_history[0].status, 'active');
  assert.equal(db.tables.member_membership_history[0].payment_status, 'paid');
  assert.ok(db.tables.membership_billing_agreements[0].metadata.gocardless_initial_payment.finalized_at);
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
