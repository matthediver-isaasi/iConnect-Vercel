import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canShowTeamRoleControl,
  canClearTeamRole,
  getAssignableTeamRoles,
} from './teamRoleAssignment.js';

test('role control uses the Login Access visibility permission', () => {
  assert.equal(canShowTeamRoleControl((key) => key === 'element_TeamLoginAccessToggle'), false);
  assert.equal(canShowTeamRoleControl(() => false), true);
});

test('only privileged administrators are offered role removal', () => {
  assert.equal(canClearTeamRole(false), false);
  assert.equal(canClearTeamRole(true), true);
});

test('options contain configured non-admin roles and preserve the current role', () => {
  const roles = [
    { id: 'allowed' },
    { id: 'current' },
    { id: 'blocked' },
    { id: 'admin', is_tenant_admin: true },
  ];
  assert.deepEqual(
    getAssignableTeamRoles(roles, { assignable_role_ids: ['allowed', 'admin'] }, 'current').map((r) => r.id),
    ['allowed', 'current'],
  );
});

test('an empty policy exposes no destinations except the displayed current role', () => {
  assert.deepEqual(
    getAssignableTeamRoles([{ id: 'current' }, { id: 'other' }], { assignable_role_ids: [] }, 'current')
      .map((r) => r.id),
    ['current'],
  );
});