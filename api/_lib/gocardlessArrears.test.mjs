// GoCardless Phase 4 arrears tests (pure helpers + fake supabase db).
// Run: node --test api/_lib/gocardlessArrears.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { STATUS } from './gocardlessState.js';
import {
  DEFAULT_GRACE_DAYS,
  graceDaysForAgreement,
  computeGraceExpiry,
  isGraceExpired,
  resolveArrearsPolicy,
  assertRetryablePayment,
  handlePaymentFailure,
  applyArrearsPolicy,
  recoveryPlanUpdate,
  clearAgreementArrearsFlag,
} from './gocardlessArrears.js';

// ---------------------------------------------------------------------------
// Minimal in-memory supabase-shaped fake (mirrors webhook processor tests)
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
    }
    select() { if (!this.op) this.op = 'select'; return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
    is(col, val) { this.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
    in(col, vals) { this.filters.push((r) => vals.includes(r[col])); return this; }
    not() { return this; }
    lte(col, val) { this.filters.push((r) => r[col] <= val); return this; }
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

  return { tables, from(table) { return new Query(table); } };
}

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Grace math (snapshot is the contract)
// ---------------------------------------------------------------------------

test('graceDaysForAgreement reads the snapshot, not live config', () => {
  assert.equal(graceDaysForAgreement({ metadata: { dd: { grace_days: 14 } } }), 14);
  assert.equal(graceDaysForAgreement({ metadata: { dd: { grace_days: 0 } } }), 0);
  assert.equal(graceDaysForAgreement({ metadata: { dd: {} } }), DEFAULT_GRACE_DAYS);
  assert.equal(graceDaysForAgreement(null), DEFAULT_GRACE_DAYS);
  // clamped to 90, floored to integer, garbage → default
  assert.equal(graceDaysForAgreement({ metadata: { dd: { grace_days: 900 } } }), 90);
  assert.equal(graceDaysForAgreement({ metadata: { dd: { grace_days: 3.9 } } }), 3);
  assert.equal(graceDaysForAgreement({ metadata: { dd: { grace_days: 'soon' } } }), DEFAULT_GRACE_DAYS);
  assert.equal(graceDaysForAgreement({ metadata: { dd: { grace_days: -5 } } }), DEFAULT_GRACE_DAYS);
});

test('computeGraceExpiry adds snapshot days + admin extension', () => {
  const failedAt = new Date('2026-07-01T00:00:00Z');
  assert.equal(computeGraceExpiry(failedAt, 7).getTime(), failedAt.getTime() + 7 * DAY);
  assert.equal(computeGraceExpiry(failedAt, 7, 3).getTime(), failedAt.getTime() + 10 * DAY);
  assert.equal(computeGraceExpiry(failedAt, 0).getTime(), failedAt.getTime());
  assert.throws(() => computeGraceExpiry('not-a-date', 7));
});

test('isGraceExpired', () => {
  const now = new Date('2026-07-10T00:00:00Z');
  assert.equal(isGraceExpired({ grace_expires_at: '2026-07-09T00:00:00Z' }, now), true);
  assert.equal(isGraceExpired({ grace_expires_at: '2026-07-10T00:00:00Z' }, now), true);
  assert.equal(isGraceExpired({ grace_expires_at: '2026-07-11T00:00:00Z' }, now), false);
  assert.equal(isGraceExpired({ grace_expires_at: null }, now), false);
  assert.equal(isGraceExpired(null, now), false);
});

test('resolveArrearsPolicy collapses unknowns to manual_review', () => {
  assert.equal(resolveArrearsPolicy({ dd_arrears_policy: 'suspend' }), 'suspend');
  assert.equal(resolveArrearsPolicy({ dd_arrears_policy: 'keep_active' }), 'keep_active');
  assert.equal(resolveArrearsPolicy({ dd_arrears_policy: 'nuke' }), 'manual_review');
  assert.equal(resolveArrearsPolicy(null), 'manual_review');
});

// ---------------------------------------------------------------------------
// Never-double-charge guard MUST throw (fail-closed)
// ---------------------------------------------------------------------------

test('assertRetryablePayment throws unless GC says failed', () => {
  assert.equal(assertRetryablePayment({ status: 'failed' }), true);
  assert.throws(() => assertRetryablePayment(null), /never-double-charge/);
  for (const status of ['pending_submission', 'submitted', 'confirmed', 'paid_out', 'cancelled', 'charged_back']) {
    assert.throws(() => assertRetryablePayment({ status }), /never-double-charge/);
  }
});

// ---------------------------------------------------------------------------
// handlePaymentFailure — grace open/keep, overdue escalation
// ---------------------------------------------------------------------------

function planRow(over = {}) {
  return {
    id: 'plan-1',
    status: STATUS.ACTIVE,
    retry_count: 0,
    grace_expires_at: null,
    grace_extended_days: 0,
    ...over,
  };
}

test('first failure opens a grace window from the snapshot grace_days', async () => {
  const db = makeFakeDb({ membership_payment_plans: [planRow()], membership_payment_status_history: [] });
  const agreement = { metadata: { dd: { grace_days: 10 } } };
  const before = Date.now();
  const out = await handlePaymentFailure({ plan: db.tables.membership_payment_plans[0], agreement, action: 'failed', db });
  assert.equal(out.toStatus, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(out.retryCount, 1);
  const expiry = new Date(out.graceExpiresAt).getTime();
  assert.ok(Math.abs(expiry - (before + 10 * DAY)) < 5000);
  const row = db.tables.membership_payment_plans[0];
  assert.equal(row.status, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(row.retry_count, 1);
});

test('repeat failure inside grace keeps the original window (no rolling grace)', async () => {
  const expiresAt = new Date(Date.now() + 3 * DAY).toISOString();
  const db = makeFakeDb({
    membership_payment_plans: [planRow({ status: STATUS.PAYMENT_GRACE_PERIOD, retry_count: 1, grace_expires_at: expiresAt })],
    membership_payment_status_history: [],
  });
  const out = await handlePaymentFailure({ plan: db.tables.membership_payment_plans[0], agreement: { metadata: { dd: { grace_days: 10 } } }, db });
  assert.equal(out.toStatus, STATUS.PAYMENT_GRACE_PERIOD);
  assert.equal(out.graceExpiresAt, expiresAt);
  assert.equal(db.tables.membership_payment_plans[0].retry_count, 2);
});

test('failure after grace expiry escalates to overdue', async () => {
  const expiresAt = new Date(Date.now() - DAY).toISOString();
  const db = makeFakeDb({
    membership_payment_plans: [planRow({ status: STATUS.PAYMENT_GRACE_PERIOD, retry_count: 2, grace_expires_at: expiresAt })],
    membership_payment_status_history: [],
  });
  const out = await handlePaymentFailure({ plan: db.tables.membership_payment_plans[0], agreement: null, db });
  assert.equal(out.toStatus, STATUS.PAYMENT_OVERDUE);
  assert.equal(db.tables.membership_payment_plans[0].status, STATUS.PAYMENT_OVERDUE);
});

// ---------------------------------------------------------------------------
// applyArrearsPolicy — idempotent, records policy, flags agreement
// ---------------------------------------------------------------------------

test('applyArrearsPolicy applies once and is idempotent thereafter', async () => {
  const agreement = { id: 'ag-1', metadata: { dd: { grace_days: 7 } } };
  const db = makeFakeDb({
    membership_payment_plans: [planRow({ status: STATUS.PAYMENT_GRACE_PERIOD, grace_expires_at: new Date(Date.now() - DAY).toISOString() })],
    membership_billing_agreements: [agreement],
    membership_payment_status_history: [],
  });
  const plan = db.tables.membership_payment_plans[0];

  const first = await applyArrearsPolicy({ plan, agreement, tierConfig: { dd_arrears_policy: 'suspend' }, db });
  assert.equal(first.applied, true);
  assert.equal(first.policy, 'suspend');
  const row = db.tables.membership_payment_plans[0];
  assert.equal(row.status, STATUS.PAYMENT_OVERDUE);
  assert.equal(row.arrears_policy_applied, 'suspend');
  assert.equal(db.tables.membership_billing_agreements[0].metadata.dd.arrears_state, 'suspend');

  const second = await applyArrearsPolicy({ plan: { ...row }, agreement, tierConfig: { dd_arrears_policy: 'restrict' }, db });
  assert.equal(second.applied, false);
  assert.equal(second.policy, 'suspend'); // original decision stands
  assert.equal(db.tables.membership_payment_plans[0].arrears_policy_applied, 'suspend');
});

test('keep_active policy records but never flags the agreement', async () => {
  const agreement = { id: 'ag-2', metadata: { dd: {} } };
  const db = makeFakeDb({
    membership_payment_plans: [planRow({ status: STATUS.PAYMENT_GRACE_PERIOD })],
    membership_billing_agreements: [agreement],
    membership_payment_status_history: [],
  });
  const out = await applyArrearsPolicy({ plan: db.tables.membership_payment_plans[0], agreement, tierConfig: { dd_arrears_policy: 'keep_active' }, db });
  assert.equal(out.applied, true);
  assert.equal(out.policy, 'keep_active');
  assert.equal(db.tables.membership_billing_agreements[0].metadata.dd.arrears_state, undefined);
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

test('recoveryPlanUpdate clears all arrears bookkeeping', () => {
  assert.deepEqual(recoveryPlanUpdate(), {
    retry_count: 0,
    grace_expires_at: null,
    arrears_policy_applied: null,
    arrears_policy_applied_at: null,
  });
});

test('clearAgreementArrearsFlag removes the flag once', async () => {
  const agreement = { id: 'ag-3', metadata: { dd: { arrears_state: 'suspend', arrears_flagged_at: 'x', grace_days: 7 } } };
  const db = makeFakeDb({ membership_billing_agreements: [agreement] });
  const out = await clearAgreementArrearsFlag(agreement, { db });
  assert.equal(out.cleared, true);
  const row = db.tables.membership_billing_agreements[0];
  assert.equal(row.metadata.dd.arrears_state, undefined);
  assert.equal(row.metadata.dd.grace_days, 7);
  const noop = await clearAgreementArrearsFlag({ ...agreement, metadata: row.metadata }, { db });
  assert.equal(noop.cleared, false);
});
