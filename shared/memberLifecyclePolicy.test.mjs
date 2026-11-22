import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIFECYCLE_POLICY, validateLifecyclePolicy, lifecycleDay, lifecycleAnniversary,
  evaluateMemberLifecycle } from './memberLifecyclePolicy.mjs';

const formerRole = '11111111-1111-4111-8111-111111111111';
const guestRole = '22222222-2222-4222-8222-222222222222';
function fixture() {
  return {
    tenantId: 'tenant-a',
    policy: { ...DEFAULT_LIFECYCLE_POLICY, formerRoleId: formerRole, guestRoleId: guestRole, guestRoleIds: [guestRole] },
    member: { id: 'member-a', tenant_id: 'tenant-a', lifecycle_state: 'former', role_id: formerRole },
    roles: [{ id: formerRole, tenant_id: 'tenant-a' }, { id: guestRole, tenant_id: 'tenant-a' }],
    evidence: { tenantId: 'tenant-a', memberId: 'member-a', membershipComplete: true, obligationsComplete: true,
      blockers: [], membership: { historyKind: 'former', graceEndDate: '2020-11-22' },
      activity: Object.fromEntries(['event_attendance', 'cpd_activity', 'portal_login'].map(type =>
        [type, { complete: true, lastOccurredAt: '2020-11-22' }])) },
    now: new Date('2026-11-22T12:00:00Z'),
  };
}
const evaluate = configure => { const input = fixture(); configure?.(input); return evaluateMemberLifecycle(input); };
test('policy is tenant-independent and excludes activation from writable settings', () => {
  assert.equal(DEFAULT_LIFECYCLE_POLICY.formerRoleId, null);
  assert.throws(() => validateLifecyclePolicy({ enabled: true }), /Unknown/);
  for (const value of [-1, 1.5, 101, '5', null]) {
    assert.throws(() => validateLifecyclePolicy({ formerRetentionYears: value }));
  }
  assert.throws(() => validateLifecyclePolicy({ activities: [] }));
  assert.throws(() => validateLifecyclePolicy({ activities: ['admin_edit'] }));
  assert.throws(() => validateLifecyclePolicy({ timezone: 'made-up' }));
  assert.throws(() => validateLifecyclePolicy({ formerRoleId: 'Former Member' }));
});
test('calendar anniversaries clamp leap days and respect tenant timezone', () => {
  assert.equal(lifecycleAnniversary('2024-02-29', 1), '2025-02-28');
  assert.equal(lifecycleAnniversary('2024-02-29', 4), '2028-02-29');
  assert.equal(lifecycleDay('2026-11-22T23:30:00Z', 'Europe/Madrid'), '2026-11-23');
  assert.throws(() => lifecycleDay('2026-02-30'));
});
test('first expired transition changes configured role, without skipping straight to archive', () => {
  const value = evaluate(input => { input.member.lifecycle_state = 'active'; });
  assert.equal(value.action, 'former');
  assert.equal(value.targetRoleId, formerRole);
});
test('grace includes the final configured day', () => {
  assert.equal(evaluate(input => { input.now = '2020-11-22'; }).reason, 'within_membership_grace');
});
test('former inactivity archives only when both retention clocks have elapsed', () => {
  assert.equal(evaluate().action, 'archive');
  assert.equal(evaluate(input => { input.now = '2025-11-21'; }).action, 'none');
  assert.equal(evaluate(input => { input.now = '2025-11-22'; }).action, 'archive');
});
test('real member login extends retention and transitions former members to configured guest role', () => {
  const value = evaluate(input => { input.evidence.activity.portal_login.lastOccurredAt = '2026-11-01'; });
  assert.equal(value.action, 'guest');
  assert.equal(value.targetRoleId, guestRole);
});
test('event-only guest rule ignores more recent portal login and CPD', () => {
  assert.equal(evaluate(input => {
    input.member.role_id = guestRole;
    input.policy.eventOnlyRoleIds = [guestRole];
    input.evidence.activity.portal_login.lastOccurredAt = '2026-11-01';
    input.evidence.activity.cpd_activity.lastOccurredAt = '2026-11-01';
  }).action, 'archive');
});
test('never-member guests enter deletion review, never automatic deletion', () => {
  assert.equal(evaluate(input => {
    input.member.role_id = guestRole;
    input.evidence.membership.historyKind = 'never';
  }).action, 'deletion_review');
});
test('unknown history cannot be inferred from a guest role', () => {
  assert.equal(evaluate(input => {
    input.member.role_id = guestRole;
    input.evidence.membership.historyKind = 'unknown';
  }).reason, 'membership_history_unknown');
});
test('missing, failed and future activity evidence holds without mutation', () => {
  assert.equal(evaluate(input => { delete input.evidence.activity.portal_login; }).reason, 'activity_source_incomplete');
  assert.equal(evaluate(input => {
    Object.values(input.evidence.activity).forEach(source => { source.lastOccurredAt = null; });
  }).reason, 'last_activity_unknown');
  assert.equal(evaluate(input => { input.evidence.activity.portal_login.lastOccurredAt = '2027-01-01'; }).reason, 'future_activity_date');
});
test('active, purchased future and pending renewal evidence protects accounts', () => {
  for (const key of ['active', 'futureEntitlement', 'pendingRenewal']) {
    assert.equal(evaluate(input => { input.evidence.membership[key] = true; }).reason, 'membership_protected');
  }
});
test('billing uncertainty and obligations block transitions', () => {
  assert.equal(evaluate(input => { input.evidence.obligationsComplete = false; }).action, 'evidence_review');
  assert.equal(evaluate(input => { input.evidence.blockers = ['recurring_agreement']; }).reason, 'unresolved_obligations');
});
test('exemptions and retain holds override processing', () => {
  for (const key of ['lifecycle_exempt', 'lifecycle_hold']) {
    assert.equal(evaluate(input => { input.member[key] = true; }).reason, 'administrator_hold');
  }
  assert.equal(evaluate(input => { input.member.lifecycle_review_after = '2027-01-01'; }).reason, 'retention_extended');
});
test('missing, cross-tenant and privileged destination roles are rejected', () => {
  for (const change of [
    input => { input.policy.formerRoleId = null; },
    input => { input.roles[0].tenant_id = 'tenant-b'; },
    input => { input.roles[0].is_active = false; },
  ]) assert.equal(evaluate(input => { input.member.lifecycle_state = 'active'; change(input); }).reason, 'destination_role_unavailable');
});
test('current administrator roles cannot be silently demoted or archived', () => {
  assert.equal(evaluate(input => { input.roles[0].is_tenant_admin = true; }).reason, 'administrator_role_requires_review');
  assert.equal(evaluate(input => {
    input.evidence.activity.portal_login.lastOccurredAt = '2026-11-01';
    input.roles[1].is_tenant_admin = true;
  }).reason, 'destination_role_unavailable');
});
test('archived former members enter review one year after archiving', () => {
  assert.equal(evaluate(input => {
    input.member.lifecycle_state = 'archived';
    input.member.lifecycle_archived_at = '2025-11-22';
  }).action, 'deletion_review');
  assert.equal(evaluate(input => {
    input.member.lifecycle_state = 'archived';
    input.member.lifecycle_archived_at = '2025-11-23';
  }).reason, 'archive_retention_running');
});
test('tenant and member scope mismatches are held', () => {
  assert.equal(evaluate(input => { input.member.tenant_id = 'tenant-b'; }).reason, 'evidence_scope_mismatch');
  assert.equal(evaluate(input => { input.evidence.memberId = 'member-b'; }).reason, 'evidence_scope_mismatch');
});
test('evaluation never mutates input or returns destructive action', () => {
  const input = fixture(), before = JSON.stringify(input);
  assert.equal(evaluateMemberLifecycle(input).action, 'archive');
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(evaluate().action, 'delete');
  assert.notEqual(evaluate().action, 'minimise');
});
