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
  applyArrearsRestrictionRole,
  restoreArrearsRoleAssignments,
  recoveryPlanUpdate,
  clearAgreementArrearsFlag,
} from './gocardlessArrears.js';
import { validateArrearsPolicy } from '../membership/tiers.js';

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

  return {
    tables,
    from(table) { return new Query(table); },
    async rpc(name, args) {
      if (name === 'apply_membership_arrears_fallback_role') {
        const plan = ensure('membership_payment_plans').find((row) => (
          row.id === args.p_plan_id && row.tenant_id === args.p_tenant_id
        ));
        if (!plan) return { data: null, error: { message: 'invalid payment plan tenant' } };
        const role = ensure('role').find((row) => (
          row.id === args.p_assigned_role_id && row.tenant_id === args.p_tenant_id
        ));
        if (!role || role.is_tenant_admin) {
          return { data: null, error: { message: 'invalid fallback role' } };
        }
        const member = ensure('member').find((row) => (
          row.id === args.p_member_id && row.tenant_id === args.p_tenant_id
        ));
        if (!member) return { data: [{ result_status: 'member_missing' }], error: null };
        const isPlanTarget = plan.member_id
          ? member.id === plan.member_id
          : !!plan.organization_id && member.organization_id === plan.organization_id;
        if (!isPlanTarget) return { data: null, error: { message: 'invalid payment plan target' } };
        const currentRole = ensure('role').find((row) => (
          row.id === member.role_id && row.tenant_id === args.p_tenant_id
        ));
        if (currentRole?.is_tenant_admin) {
          return { data: [{ result_status: 'tenant_admin_protected' }], error: null };
        }
        const existing = ensure('membership_arrears_role_action').find((row) => (
          row.tenant_id === args.p_tenant_id
          && row.plan_id === args.p_plan_id
          && row.member_id === args.p_member_id
          && row.restored_at == null
        ));
        if (existing) return { data: [{ result_status: 'already_applied' }], error: null };
        if (member.role_id === args.p_assigned_role_id) {
          return { data: [{ result_status: 'already_has_role' }], error: null };
        }
        const action = {
          id: crypto.randomUUID(),
          tenant_id: args.p_tenant_id,
          plan_id: args.p_plan_id,
          member_id: args.p_member_id,
          config_id: args.p_config_id,
          previous_role_id: member.role_id,
          assigned_role_id: args.p_assigned_role_id,
          applied_at: new Date().toISOString(),
          restored_at: null,
          restoration_status: null,
        };
        ensure('membership_arrears_role_action').push(action);
        member.role_id = args.p_assigned_role_id;
        return {
          data: [{
            result_status: 'applied',
            original_role_id: action.previous_role_id,
            assigned_role_name: role.name,
            role_action_id: action.id,
          }],
          error: null,
        };
      }
      if (name === 'restore_membership_arrears_fallback_role') {
        const action = ensure('membership_arrears_role_action').find((row) => (
          row.id === args.p_action_id && row.tenant_id === args.p_tenant_id
        ));
        if (!action || action.restored_at != null) {
          return { data: [{ result_status: 'already_completed' }], error: null };
        }
        const member = ensure('member').find((row) => (
          row.id === action.member_id && row.tenant_id === args.p_tenant_id
        ));
        let status = 'member_missing';
        if (member?.role_id === action.assigned_role_id) {
          member.role_id = action.previous_role_id;
          status = 'restored';
        } else if (member) {
          status = 'manual_change_preserved';
        }
        action.restored_at = new Date().toISOString();
        action.restoration_status = status;
        return { data: [{ result_status: status }], error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  };
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

test('recurring restriction configuration requires a role from the same tenant', async () => {
  const db = makeFakeDb({
    role: [
      { id: 'role-local', tenant_id: 'tenant-1' },
      { id: 'role-foreign', tenant_id: 'tenant-2' },
      { id: 'role-admin', tenant_id: 'tenant-1', is_tenant_admin: true },
    ],
  });
  const missing = await validateArrearsPolicy('tenant-1', {
    dd_arrears_policy: 'restrict',
    dd_arrears_fallback_role_id: null,
  }, db);
  assert.equal(missing.field, 'dd_arrears_fallback_role_id');

  const foreign = await validateArrearsPolicy('tenant-1', {
    dd_arrears_policy: 'restrict',
    dd_arrears_fallback_role_id: 'role-foreign',
  }, db);
  assert.equal(foreign.field, 'dd_arrears_fallback_role_id');

  const admin = await validateArrearsPolicy('tenant-1', {
    dd_arrears_policy: 'restrict',
    dd_arrears_fallback_role_id: 'role-admin',
  }, db);
  assert.equal(admin.field, 'dd_arrears_fallback_role_id');

  const valid = await validateArrearsPolicy('tenant-1', {
    dd_arrears_policy: 'restrict',
    dd_arrears_fallback_role_id: 'role-local',
  }, db);
  assert.deepEqual(valid.fields, {
    dd_arrears_policy: 'restrict',
    dd_arrears_fallback_role_id: 'role-local',
  });
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

test('restriction assigns and idempotently restores a member-owned plan role', async () => {
  const db = makeFakeDb({
    role: [
      { id: 'role-member', tenant_id: 'tenant-1', name: 'Member', is_tenant_admin: false },
      { id: 'role-limited', tenant_id: 'tenant-1', name: 'Limited Access', is_tenant_admin: false },
    ],
    member: [{
      id: 'member-1',
      tenant_id: 'tenant-1',
      organization_id: null,
      role_id: 'role-member',
    }],
    membership_payment_plans: [planRow({ tenant_id: 'tenant-1', member_id: 'member-1' })],
    membership_arrears_role_action: [],
  });
  const plan = db.tables.membership_payment_plans[0];
  const agreement = { id: 'ag-role-1', tenant_id: 'tenant-1', member_id: 'member-1' };
  const tierConfig = {
    id: 'config-1',
    dd_arrears_policy: 'restrict',
    dd_arrears_fallback_role_id: 'role-limited',
  };

  const applied = await applyArrearsRestrictionRole({ plan, agreement, tierConfig, db });
  assert.equal(applied.assigned, 1);
  assert.equal(applied.roleName, 'Limited Access');
  assert.equal(db.tables.member[0].role_id, 'role-limited');
  assert.equal(db.tables.membership_arrears_role_action.length, 1);
  assert.equal(db.tables.membership_arrears_role_action[0].previous_role_id, 'role-member');

  const duplicate = await applyArrearsRestrictionRole({ plan, agreement, tierConfig, db });
  assert.equal(duplicate.assigned, 0);
  assert.equal(db.tables.membership_arrears_role_action.length, 1);

  const restored = await restoreArrearsRoleAssignments({ plan, agreement, db });
  assert.deepEqual(restored, { restored: 1, preserved: 0 });
  assert.equal(db.tables.member[0].role_id, 'role-member');
  assert.equal(db.tables.membership_arrears_role_action[0].restoration_status, 'restored');
  assert.deepEqual(
    await restoreArrearsRoleAssignments({ plan, agreement, db }),
    { restored: 0, preserved: 0 },
  );

  const reapplied = await applyArrearsRestrictionRole({ plan, agreement, tierConfig, db });
  assert.equal(reapplied.assigned, 1);
  assert.equal(db.tables.membership_arrears_role_action.length, 2);
});

test('organisation restriction fans out, protects tenant admins, and preserves manual role changes', async () => {
  const db = makeFakeDb({
    role: [
      { id: 'role-member', tenant_id: 'tenant-1', name: 'Member', is_tenant_admin: false },
      { id: 'role-admin', tenant_id: 'tenant-1', name: 'Admin', is_tenant_admin: true },
      { id: 'role-limited', tenant_id: 'tenant-1', name: 'Limited', is_tenant_admin: false },
      { id: 'role-manual', tenant_id: 'tenant-1', name: 'Manual', is_tenant_admin: false },
    ],
    member: [
      { id: 'member-1', tenant_id: 'tenant-1', organization_id: 'org-1', role_id: 'role-member' },
      { id: 'member-2', tenant_id: 'tenant-1', organization_id: 'org-1', role_id: 'role-admin' },
      { id: 'foreign-member', tenant_id: 'tenant-2', organization_id: 'org-1', role_id: 'role-member' },
    ],
    membership_payment_plans: [planRow({
      tenant_id: 'tenant-1',
      member_id: null,
      organization_id: 'org-1',
    })],
    membership_arrears_role_action: [],
  });
  const plan = db.tables.membership_payment_plans[0];
  const agreement = { id: 'ag-role-2', tenant_id: 'tenant-1', organization_id: 'org-1' };
  const tierConfig = {
    id: 'config-1',
    dd_arrears_policy: 'restrict',
    dd_arrears_fallback_role_id: 'role-limited',
  };

  const applied = await applyArrearsRestrictionRole({ plan, agreement, tierConfig, db });
  assert.equal(applied.assigned, 1);
  assert.equal(applied.skipped, 1);
  assert.equal(db.tables.member.find((row) => row.id === 'member-1').role_id, 'role-limited');
  assert.equal(db.tables.member.find((row) => row.id === 'member-2').role_id, 'role-admin');
  assert.equal(db.tables.member.find((row) => row.id === 'foreign-member').role_id, 'role-member');

  db.tables.member.find((row) => row.id === 'member-1').role_id = 'role-manual';
  const recovered = await restoreArrearsRoleAssignments({ plan, agreement, db });
  assert.deepEqual(recovered, { restored: 0, preserved: 1 });
  assert.equal(db.tables.member.find((row) => row.id === 'member-1').role_id, 'role-manual');
  assert.equal(db.tables.membership_arrears_role_action[0].restoration_status, 'manual_change_preserved');
});

test('restriction fails closed for missing or cross-tenant fallback roles', async () => {
  const db = makeFakeDb({
    role: [{ id: 'role-foreign', tenant_id: 'tenant-2', name: 'Foreign role' }],
    member: [{ id: 'member-1', tenant_id: 'tenant-1', role_id: 'role-member' }],
    membership_payment_plans: [planRow({ tenant_id: 'tenant-1', member_id: 'member-1' })],
    membership_arrears_role_action: [],
  });
  const plan = db.tables.membership_payment_plans[0];
  const agreement = { tenant_id: 'tenant-1', member_id: 'member-1' };

  const missing = await applyArrearsRestrictionRole({
    plan,
    agreement,
    tierConfig: { dd_arrears_policy: 'restrict', dd_arrears_fallback_role_id: null },
    db,
  });
  assert.equal(missing.reason, 'missing-fallback-role');
  assert.equal(db.tables.member[0].role_id, 'role-member');
  assert.match(plan.attention_reason, /requires a fallback role/);

  const foreign = await applyArrearsRestrictionRole({
    plan,
    agreement,
    tierConfig: { dd_arrears_policy: 'restrict', dd_arrears_fallback_role_id: 'role-foreign' },
    db,
  });
  assert.equal(foreign.reason, 'invalid-fallback-role');
  assert.equal(db.tables.member[0].role_id, 'role-member');
  assert.equal(db.tables.membership_arrears_role_action.length, 0);
});

test('atomic restriction rejects a member who is not the payment plan target', async () => {
  const db = makeFakeDb({
    role: [
      { id: 'role-member', tenant_id: 'tenant-1', name: 'Member', is_tenant_admin: false },
      { id: 'role-limited', tenant_id: 'tenant-1', name: 'Limited', is_tenant_admin: false },
    ],
    member: [
      { id: 'member-1', tenant_id: 'tenant-1', organization_id: 'org-1', role_id: 'role-member' },
      { id: 'member-2', tenant_id: 'tenant-1', organization_id: 'org-2', role_id: 'role-member' },
    ],
    membership_payment_plans: [planRow({
      tenant_id: 'tenant-1',
      member_id: null,
      organization_id: 'org-1',
    })],
    membership_arrears_role_action: [],
  });

  const { error } = await db.rpc('apply_membership_arrears_fallback_role', {
    p_tenant_id: 'tenant-1',
    p_plan_id: 'plan-1',
    p_member_id: 'member-2',
    p_config_id: 'config-1',
    p_assigned_role_id: 'role-limited',
  });
  assert.match(error.message, /invalid payment plan target/);
  assert.equal(db.tables.member[1].role_id, 'role-member');
  assert.equal(db.tables.membership_arrears_role_action.length, 0);
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
