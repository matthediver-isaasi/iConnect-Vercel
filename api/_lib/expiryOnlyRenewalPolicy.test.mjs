import test from 'node:test';
import assert from 'node:assert/strict';
import { loadExpiryOnlyRenewalPolicy, expiryOnlyRenewalPolicyDisplay, expiryOnlyLifecycle,
  EXPIRY_POLICY_TABLE } from './expiryOnlyRenewalPolicy.js';
import { rejectGenericServerOwnedEntity } from './serverOwnedEntityBoundary.js';
import { main } from '../../scripts/assign-bnms-expiry-only-renewal-policy.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const history = { id: 'history', tenant_id: tenant, member_id: 'member', status: 'active',
  membership_year: '2025/2026', payment_status: 'paid', payment_method: 'upfront',
  currency: 'GBP', billing_period: 'annual', tier_label: 'Full', term_end_date: '2026-09-25',
  notes: { source: 'bnms_non_dd_current_backfill' } };
const policy = { renewal_open_days: 90, renewal_grace_days: 90, renewal_disable_login: true,
  renewal_change_role: false, renewal_fallback_role_id: null };
const assignment = { id: 'assignment', tenant_id: tenant, history_id: history.id,
  member_id: history.member_id, config_id: 'config', config_name: '2026-2027 Full member',
  expiry_date: history.term_end_date, approval_source: 'operator', policy_snapshot: policy };
function fixture({ saved = assignment, persisted = history, config = {}, member = {}, errorTable, errorCode } = {}) {
  const reads = [];
  const tables = { [EXPIRY_POLICY_TABLE]: saved,
    member_membership_history: persisted,
    member: { id: 'member', tenant_id: tenant, ...member },
    membership_tier_config: { id: 'config', tenant_id: tenant,
      structure_scope_type: 'member', billing_period: 'annual', ...config } };
  return { reads, from(table) {
    reads.push(table);
    return { select() { return this; }, eq() { return this; },
      maybeSingle: async () => table === errorTable
        ? { error: { code: errorCode, message: 'unavailable' } } : { data: tables[table] } };
  } };
}
const load = (db, row = history) => loadExpiryOnlyRenewalPolicy(db, { tenantId: tenant, history: row });

test('explicit authority anchors at known expiry, never historical commencement or live pricing', async () => {
  const before = structuredClone(history);
  const result = await load(fixture({ config: { renewal_grace_days: 0, flat_cost: 999 } }));
  assert.deepEqual(expiryOnlyRenewalPolicyDisplay(result), {
    policySource: 'operator_assigned_expiry_only', configId: 'config', configName: assignment.config_name,
    paidThroughDate: '2026-09-25', graceEndDate: '2026-12-24', renewalGraceDays: 90,
  });
  for (const [date, state] of [['2026-09-25', 'open'], ['2026-12-24', 'grace'], ['2026-12-25', 'expired']]) {
    const lifecycle = expiryOnlyLifecycle(result, new Date(date));
    assert.equal(lifecycle.state, state);
    assert.equal(lifecycle.term.start, null);
  }
  assert.deepEqual(history, before);
});

test('forged notes, absent table and nonlegacy records never establish policy authority', async () => {
  assert.equal(await load(fixture({ saved: null }), { ...history,
    notes: { ...history.notes, renewal_policy_assignment: assignment } }), null);
  assert.equal(await load(fixture({ errorTable: EXPIRY_POLICY_TABLE, errorCode: '42P01' })), null);
  const db = fixture();
  assert.equal(await load(db, { ...history, config_id: 'modern' }), null);
  assert.deepEqual(db.reads, []);
});

test('cross-tenant, stale owner/expiry, forged snapshot and missing evidence fail closed', async () => {
  for (const saved of [
    { ...assignment, tenant_id: 'other' }, { ...assignment, history_id: 'other' },
    { ...assignment, member_id: 'other' }, { ...assignment, expiry_date: '2026-09-26' },
    { ...assignment, approval_source: 'notes' },
    { ...assignment, policy_snapshot: { ...policy, renewal_grace_days: 91 } },
    { ...assignment, policy_snapshot: { ...policy, flat_cost: 100 } },
  ]) await assert.rejects(load(fixture({ saved })), /invalid/);
  for (const option of [
    { persisted: { ...history, term_end_date: '2026-09-26' } },
    { persisted: { ...history, tenant_id: 'other' } }, { persisted: null },
    { config: { tenant_id: 'other' } }, { config: { id: 'other' } },
    { member: { tenant_id: 'other' } }, { errorTable: EXPIRY_POLICY_TABLE, errorCode: '42501' },
  ]) await assert.rejects(load(fixture(option)), /unavailable/);
});

test('policy table is explicitly unavailable through generic entity aliases', () => {
  for (const name of ['MembershipExpiryPolicyAssignment', EXPIRY_POLICY_TABLE, 'membership-expiry-policy-assignment']) {
    let status;
    assert.equal(rejectGenericServerOwnedEntity(name, { status(value) { status = value; return this; }, json() {} }), true);
    assert.equal(status, 403);
  }
});

test('repair script defaults to offline plan and rejects unreviewed writes before opening a connection', async () => {
  const noConnection = () => assert.fail('Offline plan cannot open destination connection');
  await main([], noConnection);
  await assert.rejects(main(['--apply'], noConnection), /hash does not match/);
  await assert.rejects(main(['--force'], noConnection), /Supported arguments/);
});