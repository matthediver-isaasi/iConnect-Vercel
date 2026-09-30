import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { STATUS } from './gocardlessState.js';
import {
  DEFAULT_AUTO_RETRY_POLICY,
  normalizeAutoRetryPolicy,
  validateAutoRetryPolicy,
  automaticRetryDueAt,
  scheduleAutomaticRetry,
  retryPaymentSafely,
  clearAutomaticRetryForPlan,
  claimPlanForCancellation,
  closeAutomaticRetrySchedule,
  completeCancellationClaim,
} from './gocardlessAutoRetry.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222';
const DAY = 86_400_000;

function makeFakeDb(initial = {}) {
  const tables = Object.fromEntries(
    Object.entries(initial).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
  );
  const ensure = (name) => (tables[name] ||= []);

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = 'select';
      this.payload = null;
    }
    select() { return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    eq(col, value) { this.filters.push((row) => row[col] === value); return this; }
    is(col, value) { this.filters.push((row) => value === null ? row[col] == null : row[col] === value); return this; }
    not(col, op, value) { if (op === 'is' && value === null) this.filters.push((row) => row[col] != null); return this; }
    lte(col, value) { this.filters.push((row) => row[col] <= value); return this; }
    in(col, values) { this.filters.push((row) => values.includes(row[col])); return this; }
    order() { return this; }
    limit() { return this; }
    matches() { return ensure(this.table).filter((row) => this.filters.every((filter) => filter(row))); }
    run() {
      const rows = ensure(this.table);
      if (this.op === 'insert') {
        const values = Array.isArray(this.payload) ? this.payload : [this.payload];
        if (this.table === 'gocardless_payment_retry_attempts') {
          const duplicate = values.find((value) => rows.some((row) => row.idempotency_key === value.idempotency_key));
          if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate' } };
        }
        const inserted = values.map((value) => ({ id: value.id || crypto.randomUUID(), ...value }));
        rows.push(...inserted);
        return { data: inserted.map((row) => ({ ...row })), error: null };
      }
      if (this.op === 'update') {
        const matched = this.matches();
        matched.forEach((row) => Object.assign(row, this.payload));
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      return { data: this.matches().map((row) => ({ ...row })), error: null };
    }
    maybeSingle() {
      const out = this.run();
      return Promise.resolve({ data: out.data?.[0] || null, error: out.error });
    }
    then(resolve, reject) {
      try { resolve(this.run()); } catch (error) { reject(error); }
    }
  }

  return { tables, from: (table) => new Query(table) };
}

function policyRow(tenantId = TENANT, overrides = {}) {
  return {
    tenant_id: tenantId,
    integration_type: 'gocardless',
    is_enabled: true,
    credentials: {
      access_token: 'encrypted-token',
      auto_retry_enabled: true,
      auto_retry_interval_days: 2,
      auto_retry_max_attempts: 2,
      ...overrides,
    },
  };
}

function planRow(overrides = {}) {
  return {
    id: 'plan-1',
    tenant_id: TENANT,
    status: STATUS.PAYMENT_GRACE_PERIOD,
    billing_agreement_id: 'agreement-1',
    gocardless_mandate_id: 'MD1',
    gocardless_subscription_id: 'SB1',
    last_payment_id: 'PM1',
    auto_retry_attempts: 0,
    auto_retry_next_at: null,
    auto_retry_payment_id: null,
    auto_retry_claimed_at: null,
    auto_retry_claim_token: null,
    grace_expires_at: new Date(Date.now() + 10 * DAY).toISOString(),
    ...overrides,
  };
}

test('policy defaults and strict whole-number bounds', () => {
  assert.deepEqual(normalizeAutoRetryPolicy(), DEFAULT_AUTO_RETRY_POLICY);
  assert.deepEqual(validateAutoRetryPolicy({ enabled: true, intervalDays: 1, maxAttempts: 0 }), {
    enabled: true, intervalDays: 1, maxAttempts: 0,
  });
  assert.throws(() => validateAutoRetryPolicy({ enabled: true, intervalDays: 1.5, maxAttempts: 2 }), /whole number/);
  assert.throws(() => validateAutoRetryPolicy({ enabled: true, intervalDays: 31, maxAttempts: 2 }), /1 to 30/);
  assert.throws(() => validateAutoRetryPolicy({ enabled: true, intervalDays: 2, maxAttempts: 11 }), /0 to 10/);
  assert.throws(() => validateAutoRetryPolicy({ enabled: 'yes', intervalDays: 2, maxAttempts: 2 }), /boolean/);
});

test('due date is interval-based and never reaches the non-rolling grace deadline', () => {
  const failed = new Date('2026-09-01T10:00:00Z');
  assert.equal(
    automaticRetryDueAt(failed, 2, '2026-09-10T10:00:00Z').toISOString(),
    '2026-09-03T10:00:00.000Z',
  );
  assert.equal(automaticRetryDueAt(failed, 2, '2026-09-03T10:00:00Z'), null);
  assert.equal(automaticRetryDueAt(failed, 3, '2026-09-03T10:00:00Z'), null);
});

test('failure scheduling is tenant-scoped, policy-driven, and stops at the limit', async () => {
  const now = new Date('2026-09-01T10:00:00Z');
  const plan = planRow({ grace_expires_at: '2026-09-10T10:00:00Z' });
  const otherPlan = planRow({ id: 'plan-2', tenant_id: OTHER_TENANT });
  const db = makeFakeDb({
    tenant_integrations: [policyRow(), policyRow(OTHER_TENANT, { auto_retry_enabled: false })],
    membership_payment_plans: [plan, otherPlan],
  });
  const scheduled = await scheduleAutomaticRetry({ tenantId: TENANT, plan, paymentId: 'PM1', failedAt: now, db });
  assert.equal(scheduled.ok, true);
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_next_at, '2026-09-03T10:00:00.000Z');
  assert.equal(db.tables.membership_payment_plans[1].auto_retry_next_at, null);

  const exhaustedPlan = { ...db.tables.membership_payment_plans[0], auto_retry_attempts: 2 };
  const exhausted = await scheduleAutomaticRetry({ tenantId: TENANT, plan: exhaustedPlan, paymentId: 'PM1', failedAt: now, db });
  assert.equal(exhausted.reason, 'attempt_limit_exhausted');
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_next_at, null);
});

test('automatic retry re-fetches live state, records one attempt, and consumes only automatic allowance', async () => {
  const now = new Date('2026-09-03T10:00:00Z');
  const plan = planRow({ auto_retry_next_at: now.toISOString(), auto_retry_payment_id: 'PM1' });
  const db = makeFakeDb({
    tenant_integrations: [policyRow()],
    membership_payment_plans: [plan],
    gocardless_payments: [{ id: 'pay-1', tenant_id: TENANT, plan_id: plan.id, gocardless_payment_id: 'PM1', status: 'failed' }],
    gocardless_payment_retry_attempts: [],
  });
  const calls = [];
  const gc = {
    getMandate: async () => ({ status: 'active' }),
    getPayment: async (id) => { calls.push(['get', id]); return { id, status: 'failed' }; },
    retryPayment: async (id, options) => { calls.push(['retry', id, options.idempotencyKey]); return { id, status: 'pending_submission' }; },
  };
  const out = await retryPaymentSafely({ tenantId: TENANT, plan, paymentId: 'PM1', mode: 'automatic', db, gc, now });
  assert.equal(out.ok, true);
  assert.deepEqual(calls.map((call) => call[0]), ['get', 'retry']);
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_attempts, 1);
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_next_at, null);
  assert.equal(db.tables.gocardless_payment_retry_attempts[0].status, 'requested');

  const manualPlan = db.tables.membership_payment_plans[0];
  const manual = await retryPaymentSafely({ tenantId: TENANT, plan: manualPlan, paymentId: 'PM1', mode: 'manual', db, gc, now });
  assert.equal(manual.ok, true);
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_attempts, 1, 'manual retry does not consume automatic allowance');
});

test('a later confirmed failure can be manually retried again with a new idempotency key', async () => {
  const now = new Date('2026-09-03T10:00:00Z');
  const plan = planRow();
  const db = makeFakeDb({
    membership_payment_plans: [plan],
    gocardless_payments: [{ tenant_id: TENANT, plan_id: plan.id, gocardless_payment_id: 'PM1', status: 'failed' }],
    gocardless_payment_retry_attempts: [],
  });
  const keys = [];
  const gc = {
    getMandate: async () => ({ status: 'active' }),
    getPayment: async () => ({ status: 'failed' }),
    retryPayment: async (_id, options) => {
      keys.push(options.idempotencyKey);
      return { status: 'pending_submission' };
    },
  };
  assert.equal((await retryPaymentSafely({ tenantId: TENANT, plan, paymentId: 'PM1', mode: 'manual', db, gc, now })).ok, true);
  assert.equal((await retryPaymentSafely({
    tenantId: TENANT, plan: db.tables.membership_payment_plans[0], paymentId: 'PM1', mode: 'manual', db, gc,
    now: new Date(now.getTime() + DAY),
  })).ok, true);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.deepEqual(
    db.tables.gocardless_payment_retry_attempts.filter((attempt) => attempt.mode === 'manual').map((attempt) => attempt.attempt_number),
    [1, 2],
  );
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_attempts, 0);
});

test('a cancellation that invalidates the claim prevents the provider retry call', async () => {
  const now = new Date('2026-09-03T10:00:00Z');
  const plan = planRow({ auto_retry_next_at: now.toISOString(), auto_retry_payment_id: 'PM1' });
  const db = makeFakeDb({
    tenant_integrations: [policyRow()],
    membership_payment_plans: [plan],
    gocardless_payments: [{ tenant_id: TENANT, plan_id: plan.id, gocardless_payment_id: 'PM1', status: 'failed' }],
    gocardless_payment_retry_attempts: [],
  });
  let retries = 0;
  let mandateReads = 0;
  const out = await retryPaymentSafely({
    tenantId: TENANT, plan, paymentId: 'PM1', mode: 'automatic', db, now,
    gc: {
      getMandate: async () => {
        mandateReads++;
        if (mandateReads === 2) {
          Object.assign(db.tables.membership_payment_plans[0], {
            status: STATUS.PAYMENT_PLAN_CANCELLED,
            auto_retry_claimed_at: null,
            auto_retry_claim_token: null,
          });
        }
        return { status: 'active' };
      },
      getPayment: async () => ({ status: 'failed' }),
      retryPayment: async () => { retries++; return { status: 'pending_submission' }; },
    },
  });
  assert.equal(out.reason, 'claim_invalidated');
  assert.equal(retries, 0);
});

test('cancellation cannot overwrite a retry claim and its own claim blocks future retries until terminal settlement', async () => {
  const now = new Date('2026-09-03T10:00:00Z');
  const retryingPlan = planRow({
    auto_retry_claimed_at: now.toISOString(),
    auto_retry_claim_token: 'retry-token',
  });
  const db = makeFakeDb({ membership_payment_plans: [retryingPlan], gocardless_payment_retry_attempts: [] });
  assert.equal(await claimPlanForCancellation(retryingPlan, { db, actor: 'admin' }), null);
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_claim_token, 'retry-token');

  Object.assign(db.tables.membership_payment_plans[0], {
    auto_retry_claimed_at: null,
    auto_retry_claim_token: null,
  });
  const cancellationToken = await claimPlanForCancellation(db.tables.membership_payment_plans[0], { db, actor: 'admin' });
  assert.match(cancellationToken, /^cancel:/);

  const blocked = await retryPaymentSafely({
    tenantId: TENANT,
    plan: db.tables.membership_payment_plans[0],
    paymentId: 'PM1',
    mode: 'manual',
    db,
    now: new Date(now.getTime() + 31 * 60_000),
    gc: {
      getMandate: async () => ({ status: 'active' }),
      getPayment: async () => ({ status: 'failed' }),
      retryPayment: async () => { throw new Error('must not retry during cancellation'); },
    },
  });
  assert.equal(blocked.reason, 'cancellation_in_progress');
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_claim_token, cancellationToken);
});

test('schedule cleanup preserves another operation claim and only its cancellation owner can release it', async () => {
  const retryPlan = planRow({
    auto_retry_next_at: new Date().toISOString(),
    auto_retry_claimed_at: new Date().toISOString(),
    auto_retry_claim_token: 'retry-owner',
  });
  const db = makeFakeDb({ membership_payment_plans: [retryPlan] });
  await closeAutomaticRetrySchedule(retryPlan, 'subscription_cancelled', { db });
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_claim_token, 'retry-owner');
  await completeCancellationClaim(retryPlan, 'retry-owner', { db });
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_claim_token, 'retry-owner');

  Object.assign(db.tables.membership_payment_plans[0], {
    auto_retry_claimed_at: new Date().toISOString(),
    auto_retry_claim_token: 'cancel:owner',
  });
  await completeCancellationClaim(db.tables.membership_payment_plans[0], 'cancel:owner', { db });
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_claim_token, null);
});

test('live non-failed status refuses collection and closes the due schedule', async () => {
  const now = new Date('2026-09-03T10:00:00Z');
  const plan = planRow({ auto_retry_next_at: now.toISOString(), auto_retry_payment_id: 'PM1' });
  const db = makeFakeDb({
    tenant_integrations: [policyRow()],
    membership_payment_plans: [plan],
    gocardless_payments: [{ tenant_id: TENANT, plan_id: plan.id, gocardless_payment_id: 'PM1', status: 'failed' }],
    gocardless_payment_retry_attempts: [],
  });
  const out = await retryPaymentSafely({
    tenantId: TENANT, plan, paymentId: 'PM1', mode: 'automatic', db, now,
    gc: {
      getMandate: async () => ({ status: 'active' }),
      getPayment: async () => ({ status: 'confirmed' }),
      retryPayment: async () => { throw new Error('must not retry'); },
    },
  });
  assert.equal(out.reason, 'live_status_refused');
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_next_at, null);
  assert.equal(db.tables.gocardless_payment_retry_attempts[0].status, 'refused');
});

test('plan claim prevents manual and automatic overlap', async () => {
  const now = new Date('2026-09-03T10:00:00Z');
  const plan = planRow({ auto_retry_next_at: now.toISOString(), auto_retry_payment_id: 'PM1' });
  const db = makeFakeDb({
    tenant_integrations: [policyRow()],
    membership_payment_plans: [plan],
    gocardless_payments: [{ tenant_id: TENANT, plan_id: plan.id, gocardless_payment_id: 'PM1', status: 'failed' }],
    gocardless_payment_retry_attempts: [],
  });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredProvider = new Promise((resolve) => { entered = resolve; });
  const gc = {
    getMandate: async () => ({ status: 'active' }),
    getPayment: async () => { entered(); await blocked; return { status: 'failed' }; },
    retryPayment: async () => ({ status: 'pending_submission' }),
  };
  const first = retryPaymentSafely({ tenantId: TENANT, plan, paymentId: 'PM1', mode: 'automatic', db, gc, now });
  await enteredProvider;
  const second = await retryPaymentSafely({ tenantId: TENANT, plan, paymentId: 'PM1', mode: 'manual', db, gc, now });
  assert.equal(second.reason, 'retry_in_progress');
  release();
  assert.equal((await first).ok, true);
});

test('provider errors are durable, release the claim, and retain the same automatic allowance', async () => {
  const now = new Date('2026-09-03T10:00:00Z');
  const plan = planRow({
    auto_retry_next_at: now.toISOString(),
    auto_retry_payment_id: 'PM1',
    grace_expires_at: '2026-09-10T10:00:00Z',
  });
  const db = makeFakeDb({
    tenant_integrations: [policyRow()],
    membership_payment_plans: [plan],
    gocardless_payments: [{ tenant_id: TENANT, plan_id: plan.id, gocardless_payment_id: 'PM1', status: 'failed' }],
    gocardless_payment_retry_attempts: [],
  });
  await assert.rejects(() => retryPaymentSafely({
    tenantId: TENANT, plan, paymentId: 'PM1', mode: 'automatic', db, now,
    gc: {
      getMandate: async () => ({ status: 'active' }),
      getPayment: async () => ({ status: 'failed' }),
      retryPayment: async () => { throw new Error('provider unavailable'); },
    },
  }), /provider unavailable/);
  const storedPlan = db.tables.membership_payment_plans[0];
  assert.equal(storedPlan.auto_retry_attempts, 0);
  assert.equal(storedPlan.auto_retry_claimed_at, null);
  assert.equal(storedPlan.auto_retry_last_outcome, 'provider_error');
  assert.ok(storedPlan.auto_retry_next_at);
  assert.equal(db.tables.gocardless_payment_retry_attempts[0].status, 'failed');
});

test('recovery clears scheduling and marks requested attempts recovered', async () => {
  const plan = planRow({ auto_retry_attempts: 1, auto_retry_next_at: new Date().toISOString() });
  const db = makeFakeDb({
    membership_payment_plans: [plan],
    gocardless_payment_retry_attempts: [{
      id: 'attempt-1', plan_id: plan.id, tenant_id: TENANT, status: 'requested',
    }],
  });
  await clearAutomaticRetryForPlan(plan, { db });
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_attempts, 0);
  assert.equal(db.tables.membership_payment_plans[0].auto_retry_next_at, null);
  assert.equal(db.tables.gocardless_payment_retry_attempts[0].status, 'recovered');
});