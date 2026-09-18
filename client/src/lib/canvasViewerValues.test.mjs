import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerRequestLease, getCanvasMemberValues } from './canvasViewerValues.js';

test('late auth responses are discarded after logout, identity change, replacement request or unmount', async () => {
  for (const invalidate of [
    ref => { ref.current += 1; },
    (ref, lease) => lease.cancel(),
    ref => createViewerRequestLease(ref),
  ]) {
    const ref = { current: 0 };
    const lease = createViewerRequestLease(ref);
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    let committed = false;
    const task = pending.then(() => { if (lease.isCurrent()) committed = true; });
    invalidate(ref, lease);
    settle();
    await task;
    assert.equal(committed, false);
  }
  const ref = { current: 0 };
  const lease = createViewerRequestLease(ref);
  assert.equal(lease.isCurrent(), true);
});

test('allowlisted values exclude arbitrary member fields and require both auth gates', () => {
  const member = { id: 'm', tenant_id: 't', organization_id: 'o' };
  const snapshot = { memberId: 'm', tenantId: 't', organizationId: 'o', values: {
    'member.first_name': 'Ada', 'member.last_name': null,
    'member.job_title': { unsafe: true }, 'member.organization.name': 'Society',
    'member.email': 'must-not-be-exposed@example.test',
  } };
  const input = { member, snapshot, sessionValidated: true, authResolved: true };
  assert.deepEqual(getCanvasMemberValues(input), {
    'member.first_name': 'Ada', 'member.last_name': '',
    'member.job_title': '', 'member.organization.name': 'Society',
  });
  for (const changes of [
    { sessionValidated: false }, { authResolved: false }, { member: null },
    { snapshot: { ...snapshot, tenantId: 'other' } },
    { snapshot: { ...snapshot, memberId: 'other' } },
    { snapshot: { ...snapshot, organizationId: 'other' } },
  ]) assert.deepEqual(getCanvasMemberValues({ ...input, ...changes }), {});
});