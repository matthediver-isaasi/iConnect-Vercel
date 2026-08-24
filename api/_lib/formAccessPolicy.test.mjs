import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFormAccessPolicy,
  resolveFormAccess,
  validateFormAccessPolicy,
} from './formAccessPolicy.js';

function db(tables = {}, failingTables = []) {
  const failures = new Set(failingTables);
  return {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) {
          filters.push((row) => row?.[column] === value);
          return query;
        },
        in(column, values) {
          const wanted = new Set(values);
          filters.push((row) => wanted.has(row?.[column]));
          return query;
        },
        then(resolve, reject) {
          const result = failures.has(table)
            ? { data: null, error: { message: `${table} failed` } }
            : {
                data: (tables[table] || []).filter((row) => filters.every((filter) => filter(row))),
                error: null,
              };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

const session = (tenantId = 't1') => ({
  data: { tenantId, memberId: 'm1', userType: 'member' },
});
const member = (overrides = {}) => ({
  id: 'm1',
  tenant_id: 't1',
  role_id: null,
  ...overrides,
});
const group = (id, roles = ['Chair'], overrides = {}) => ({
  id,
  tenant_id: 't1',
  is_active: true,
  roles,
  ...overrides,
});
const assignment = (groupId, groupRole = 'Chair', overrides = {}) => ({
  tenant_id: 't1',
  member_id: 'm1',
  group_id: groupId,
  group_role: groupRole,
  expires_at: null,
  ...overrides,
});
const role = (id, overrides = {}) => ({ id, tenant_id: 't1', ...overrides });
const policy = ({
  groupRules = [{ group_id: 'g1', role_names: ['Chair'] }],
  roleIds = ['r1'],
  operator = 'or',
} = {}) => ({
  version: 1,
  group_rules: groupRules,
  rbac_role_ids: roleIds,
  operator,
});

test('missing and empty policies remain unrestricted', async () => {
  assert.equal(normalizeFormAccessPolicy(null).restricted, false);
  assert.equal(normalizeFormAccessPolicy({}).restricted, false);
  assert.equal((await resolveFormAccess({ tenantId: 't1', policy: null })).code, 'UNRESTRICTED');
});

test('malformed and unsupported policy versions are rejected', () => {
  assert.equal(normalizeFormAccessPolicy([]).ok, false);
  assert.equal(normalizeFormAccessPolicy(policy({ operator: 'xor' })).ok, false);
  assert.equal(normalizeFormAccessPolicy({ ...policy(), version: 2 }).ok, false);
});

test('validation tenant-scopes references and canonicalizes whitespace and case', async () => {
  const result = await validateFormAccessPolicy({
    supabase: db({
      member_group: [group('g1', ['Vice Chair', 'Member'])],
      role: [role('r1')],
    }),
    tenantId: 't1',
    policy: policy({ groupRules: [{ group_id: 'g1', role_names: ['  vIcE   cHaIr '] }] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.policy.group_rules[0].role_names, ['Vice Chair']);

  const crossTenant = await validateFormAccessPolicy({
    supabase: db({
      member_group: [group('g1', ['Chair'], { tenant_id: 'other' })],
      role: [role('r1')],
    }),
    tenantId: 't1',
    policy: policy(),
  });
  assert.equal(crossTenant.ok, false);
});

test('restricted policy requires a valid same-tenant member session', async () => {
  const noSession = await resolveFormAccess({
    supabase: db({}), tenantId: 't1', policy: policy(), session: null,
  });
  assert.equal(noSession.code, 'AUTHENTICATION_REQUIRED');

  const wrongTenant = await resolveFormAccess({
    supabase: db({}), tenantId: 't1', policy: policy(),
    session: session('other'), member: member(),
  });
  assert.equal(wrongTenant.code, 'TENANT_MISMATCH');

  const tenantAdminOnly = await resolveFormAccess({
    supabase: db({}), tenantId: 't1', policy: policy(),
    session: { data: { tenantId: 't1', tenantUserId: 'admin', userType: 'tenant_user' } },
    member: null,
  });
  assert.equal(tenantAdminOnly.allowed, false);
});

test('a group-only rule accepts membership with any live group role', async () => {
  const result = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1', ['Chair', 'Member'])],
      member_group_assignment: [assignment('g1', 'Member')],
    }),
    tenantId: 't1',
    policy: policy({ groupRules: [{ group_id: 'g1', role_names: [] }], roleIds: [] }),
    session: session(),
    member: member(),
  });
  assert.equal(result.allowed, true);
});

test('group role filters use canonical case and collapsed whitespace', async () => {
  const result = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1', ['Vice Chair'])],
      member_group_assignment: [assignment('g1', ' VICE   CHAIR ')],
    }),
    tenantId: 't1',
    policy: policy({
      groupRules: [{ group_id: 'g1', role_names: ['vice chair'] }],
      roleIds: [],
    }),
    session: session(),
    member: member(),
  });
  assert.equal(result.allowed, true);
});

test('multiple group rules use any-rule semantics', async () => {
  const result = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1'), group('g2', ['Treasurer'])],
      member_group_assignment: [assignment('g2', 'Treasurer')],
    }),
    tenantId: 't1',
    policy: policy({
      groupRules: [
        { group_id: 'g1', role_names: ['Chair'] },
        { group_id: 'g2', role_names: ['Treasurer'] },
      ],
      roleIds: [],
    }),
    session: session(),
    member: member(),
  });
  assert.equal(result.allowed, true);
});

test('RBAC-only policies accept any selected live tenant role', async () => {
  const result = await resolveFormAccess({
    supabase: db({ role: [role('r1'), role('r2')] }),
    tenantId: 't1',
    policy: policy({ groupRules: [], roleIds: ['r1', 'r2'] }),
    session: session(),
    member: member({ role_id: 'r2' }),
  });
  assert.equal(result.allowed, true);
});

test('AND requires both dimensions while OR accepts either dimension', async () => {
  const tables = {
    member_group: [group('g1')],
    member_group_assignment: [],
    role: [role('r1')],
  };
  const base = {
    supabase: db(tables),
    tenantId: 't1',
    session: session(),
    member: member({ role_id: 'r1' }),
  };
  assert.equal((await resolveFormAccess({ ...base, policy: policy({ operator: 'and' }) })).allowed, false);
  assert.equal((await resolveFormAccess({ ...base, policy: policy({ operator: 'or' }) })).allowed, true);
});

test('expired assignments and inactive groups do not grant access', async () => {
  const expired = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1')],
      member_group_assignment: [assignment('g1', 'Chair', { expires_at: '2020-01-01T00:00:00Z' })],
    }),
    tenantId: 't1',
    policy: policy({ roleIds: [] }),
    session: session(),
    member: member(),
    now: Date.parse('2026-08-24T12:00:00Z'),
  });
  assert.equal(expired.allowed, false);

  const inactive = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1', ['Chair'], { is_active: false })],
      member_group_assignment: [assignment('g1')],
    }),
    tenantId: 't1',
    policy: policy({ roleIds: [] }),
    session: session(),
    member: member(),
  });
  assert.equal(inactive.code, 'INVALID_ACCESS_POLICY');

  const missingActiveState = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1', ['Chair'], { is_active: null })],
      member_group_assignment: [assignment('g1')],
    }),
    tenantId: 't1',
    policy: policy({ roleIds: [] }),
    session: session(),
    member: member(),
  });
  assert.equal(missingActiveState.code, 'INVALID_ACCESS_POLICY');

  const invalidExpiry = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1')],
      member_group_assignment: [assignment('g1', 'Chair', { expires_at: 'not-a-date' })],
    }),
    tenantId: 't1',
    policy: policy({ roleIds: [] }),
    session: session(),
    member: member(),
  });
  assert.equal(invalidExpiry.allowed, false);
});

test('missing groups, removed group roles, and stale RBAC roles invalidate the whole policy', async () => {
  const base = { tenantId: 't1', session: session(), member: member({ role_id: 'r1' }) };
  const missingGroup = await resolveFormAccess({
    ...base,
    supabase: db({ role: [role('r1')] }),
    policy: policy({ operator: 'or' }),
  });
  assert.equal(missingGroup.code, 'INVALID_ACCESS_POLICY');

  const removedGroupRole = await resolveFormAccess({
    ...base,
    supabase: db({
      member_group: [group('g1', ['Member'])],
      member_group_assignment: [assignment('g1', 'Member')],
      role: [role('r1')],
    }),
    policy: policy({ operator: 'or' }),
  });
  assert.equal(removedGroupRole.code, 'INVALID_ACCESS_POLICY');

  const staleRbac = await resolveFormAccess({
    ...base,
    supabase: db({
      member_group: [group('g1')],
      member_group_assignment: [assignment('g1')],
    }),
    policy: policy({ operator: 'or' }),
  });
  assert.equal(staleRbac.code, 'INVALID_ACCESS_POLICY');
});

test('assignment tenant filters prevent cross-tenant rows from matching', async () => {
  const result = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1')],
      member_group_assignment: [assignment('g1', 'Chair', { tenant_id: 'other' })],
    }),
    tenantId: 't1',
    policy: policy({ roleIds: [] }),
    session: session(),
    member: member(),
  });
  assert.equal(result.allowed, false);
});

test('lookup errors fail closed', async () => {
  const result = await resolveFormAccess({
    supabase: db({
      member_group: [group('g1')],
      member_group_assignment: [assignment('g1')],
      role: [role('r1')],
    }, ['member_group_assignment']),
    tenantId: 't1',
    policy: policy(),
    session: session(),
    member: member({ role_id: 'r1' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'ACCESS_LOOKUP_FAILED');
});