import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeAndCheckTeamRoleAssignment,
  isRoleAtCapacity,
  isStrictIsoDate,
  validateRoleAssignmentPolicy,
} from './teamRoleAssignment.js';

const base = {
  tenantCtx: { roleId: 'leader', organizationId: 'org-1' },
  targetMember: { id: 'member-1', tenant_id: 'tenant-1', organization_id: 'org-1', role_id: 'old-role' },
  callerRole: { id: 'leader', assignable_role_ids: ['role-1'] },
  destinationRole: { id: 'role-1', tenant_id: 'tenant-1', is_tenant_admin: false },
};

test('permits a configured same-organisation role assignment', () => {
  assert.deepEqual(validateRoleAssignmentPolicy(base), { ok: true });
});

test('rejects empty policies and unconfigured roles', () => {
  const result = validateRoleAssignmentPolicy({
    ...base,
    callerRole: { ...base.callerRole, assignable_role_ids: [] },
  });
  assert.equal(result.status, 403);
});

test('rejects cross-organisation and tenant-admin destinations', () => {
  assert.equal(validateRoleAssignmentPolicy({
    ...base,
    targetMember: { ...base.targetMember, organization_id: 'org-2' },
  }).status, 403);
  assert.equal(validateRoleAssignmentPolicy({
    ...base,
    destinationRole: { ...base.destinationRole, is_tenant_admin: true },
  }).status, 403);
});

test('requires a valid effective date when the destination role requires one', () => {
  const requiring = {
    ...base,
    destinationRole: { ...base.destinationRole, requires_effective_from_date: true },
  };
  assert.equal(validateRoleAssignmentPolicy(requiring).status, 400);
  assert.deepEqual(validateRoleAssignmentPolicy({ ...requiring, effectiveFrom: '2026-08-27' }), { ok: true });
});

test('required effective-date validation still runs when the role ID is unchanged', () => {
  const result = validateRoleAssignmentPolicy({
    ...base,
    targetMember: { ...base.targetMember, role_id: 'role-1' },
    destinationRole: { ...base.destinationRole, requires_effective_from_date: true },
  });
  assert.equal(result.status, 400);
});

test('effective dates reject calendar rollover values', () => {
  assert.equal(isStrictIsoDate('2026-02-28'), true);
  assert.equal(isStrictIsoDate('2026-02-31'), false);
  assert.equal(isStrictIsoDate('not-a-date'), false);
});

test('privileged callers retain tenant administration workflows', () => {
  assert.deepEqual(validateRoleAssignmentPolicy({
    ...base,
    tenantCtx: { organizationId: 'org-2' },
    callerRole: null,
    destinationRole: { ...base.destinationRole, is_tenant_admin: true },
    privileged: true,
  }), { ok: true });
});

test('organisation callers cannot clear roles while privileged callers can', () => {
  assert.equal(validateRoleAssignmentPolicy({ ...base, destinationRole: null }).status, 403);
  assert.deepEqual(validateRoleAssignmentPolicy({
    ...base,
    destinationRole: null,
    privileged: true,
  }), { ok: true });
});

test('capacity rejects a full role and permits remaining space or unlimited roles', () => {
  assert.equal(isRoleAtCapacity(3, 3), true);
  assert.equal(isRoleAtCapacity(2, 3), false);
  assert.equal(isRoleAtCapacity(100, null), false);
});

function roleDb(roles) {
  return {
    from(table) {
      assert.equal(table, 'role');
      const filters = {};
      const builder = {
        select() { return builder; },
        eq(key, value) { filters[key] = value; return builder; },
        async maybeSingle() {
          const data = roles.find((role) => Object.entries(filters).every(([key, value]) => role[key] === value)) || null;
          return { data, error: null };
        },
      };
      return builder;
    },
  };
}

test('member creation requires Login Access and a configured destination role', async () => {
  const roles = [
    { id: 'leader', tenant_id: 'tenant-1', assignable_role_ids: ['allowed'] },
    { id: 'allowed', tenant_id: 'tenant-1', max_members: null, is_tenant_admin: false },
    { id: 'blocked', tenant_id: 'tenant-1', max_members: null, is_tenant_admin: false },
  ];
  const common = {
    supabase: roleDb(roles),
    tenantCtx: {
      isAuthenticated: true,
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      roleId: 'leader',
    },
    memberId: 'new-member',
    targetMember: {
      id: 'new-member',
      tenant_id: 'tenant-1',
      organization_id: 'org-1',
      role_id: null,
    },
    effectiveFrom: null,
    hasAdminAccess: async () => false,
  };

  assert.equal((await authorizeAndCheckTeamRoleAssignment({
    ...common,
    destinationRoleId: 'allowed',
    hasFeatureAccess: async () => false,
  })).status, 403);
  assert.equal((await authorizeAndCheckTeamRoleAssignment({
    ...common,
    destinationRoleId: 'blocked',
    hasFeatureAccess: async () => true,
  })).status, 403);
  assert.equal((await authorizeAndCheckTeamRoleAssignment({
    ...common,
    destinationRoleId: 'allowed',
    hasFeatureAccess: async () => true,
  })).ok, true);
});

test('privileged member creation may assign a tenant role without an organisation policy', async () => {
  const result = await authorizeAndCheckTeamRoleAssignment({
    supabase: roleDb([
      { id: 'admin-role', tenant_id: 'tenant-1', max_members: null, is_tenant_admin: true },
    ]),
    tenantCtx: {
      isAuthenticated: true,
      tenantId: 'tenant-1',
      tenantUserId: 'tenant-user-1',
    },
    memberId: 'new-member',
    targetMember: {
      id: 'new-member',
      tenant_id: 'tenant-1',
      organization_id: 'org-2',
      role_id: null,
    },
    destinationRoleId: 'admin-role',
    effectiveFrom: null,
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
  });
  assert.equal(result.ok, true);
});