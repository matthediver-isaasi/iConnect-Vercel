import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleRows, assessLifecycleMembership, loadMemberLifecycleEvidence } from './memberLifecycleEvidence.js';
import { DEFAULT_LIFECYCLE_POLICY } from '../../shared/memberLifecyclePolicy.mjs';

function history(overrides = {}) {
  return { id: 'history', tenant_id: 'tenant', member_id: 'member', status: 'historical',
    payment_status: 'paid', term_start_date: '2019-01-01', term_end_date: '2019-12-31',
    commitment_snapshot: { config: { tenant_id: 'tenant', structure_scope_type: 'member', renewal_grace_days: 30 } },
    ...overrides };
}
const scope = { tenantId: 'tenant', memberId: 'member', today: '2026-11-22' };
test('membership assessment reuses calendar grace without deriving never-member from absence', () => {
  assert.deepEqual(assessLifecycleMembership([], scope), { historyKind: 'unknown' });
  assert.equal(assessLifecycleMembership([history()], scope).graceEndDate, '2020-01-30');
});
test('missing saved terms, unverified settlement and cross-tenant histories fail closed', () => {
  for (const overrides of [{ term_start_date: null }, { tenant_id: 'other' },
    { payment_status: 'unverified' }, { commitment_snapshot: null }]) {
    assert.throws(() => assessLifecycleMembership([history(overrides)], scope));
  }
});
test('pending/future entitlements are protected before expiry', () => {
  assert.equal(assessLifecycleMembership([history({ status: 'scheduled' })], scope).pendingRenewal, true);
  assert.equal(assessLifecycleMembership([history({ term_start_date: '2027-01-01', term_end_date: '2027-12-31' })], scope).futureEntitlement, true);
});
test('expiry role/login configuration is surfaced rather than silently overridden', () => {
  const row = history();
  row.commitment_snapshot.config.renewal_disable_login = true;
  assert.equal(assessLifecycleMembership([row], scope).expiryChangesAccess, true);
});
function pagingDb(pages) {
  const calls = [];
  return { calls, from(table) {
    const chain = {
      select(...args) { calls.push(['select', table, ...args]); return chain; },
      eq(...args) { calls.push(['eq', ...args]); return chain; },
      order(...args) { calls.push(['order', ...args]); return chain; },
      async range(from, to) { calls.push(['range', from, to]); return pages.shift(); },
    };
    return chain;
  } };
}
test('complete reads page beyond provider caps and remain tenant-scoped', async () => {
  const db = pagingDb([
    { data: [{ id: '1', tenant_id: 'tenant' }, { id: '2', tenant_id: 'tenant' }], count: 3 },
    { data: [{ id: '3', tenant_id: 'tenant' }], count: 3 },
  ]);
  assert.equal((await lifecycleRows(db, 'member', 'tenant', [], { pageSize: 2 })).length, 3);
  assert.equal(db.calls.filter(call => call[0] === 'eq' && call[1] === 'tenant_id').length, 2);
});
test('truncated pages, absent counts and duplicate rows cannot establish complete evidence', async () => {
  for (const page of [
    { data: [], count: 1 },
    { data: [], count: null },
    { data: [{ id: '1', tenant_id: 'other' }], count: 1 },
    { data: [{ id: '1', tenant_id: 'tenant' }, { id: '1', tenant_id: 'tenant' }], count: 2 },
  ]) await assert.rejects(lifecycleRows(pagingDb([page]), 'member', 'tenant'));
});
test('preparatory adapter explicitly reports incomplete activities and obligations', async () => {
  const evidence = await loadMemberLifecycleEvidence({}, 'tenant', { id: 'member', tenant_id: 'tenant' },
    DEFAULT_LIFECYCLE_POLICY, new Date('2026-11-22'), {
      readRows: async (_db, table) => table === 'member_membership_history' ? [history()] : [],
      overlays: async ({ history: rows }) => rows,
      billing: async () => ({ success: true, failures: [] }),
    });
  assert.equal(evidence.membershipComplete, true);
  assert.equal(evidence.obligationsComplete, false);
  assert.equal(evidence.activity.portal_login.complete, false);
  assert.ok(evidence.unavailableSources.includes('outstanding_obligations'));
});
