import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoleCopyPayload,
  checkRoleDuplicationAccess,
  duplicateTenantRole,
  getResourceAccessCopyChanges,
} from './roleDuplication.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function makeFakeDb({ roles = [], categories = [], members = [], rpcFailures = {} } = {}) {
  const state = {
    roles: roles.map((role) => ({ ...role })),
    categories: categories.map((category) => ({ ...category })),
    members: members.map((member) => ({ ...member })),
    inserts: [],
    deletes: [],
    rpcs: [],
  };

  const db = {
    from(table) {
      const tableRows = () => ({
        role: state.roles,
        resource_category: state.categories,
        member: state.members,
      }[table] || []);
      const filters = {};
      const query = {
        select() { return query; },
        eq(column, value) { filters[column] = value; return query; },
        maybeSingle: async () => ({
          data: tableRows().find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) || null,
          error: null,
        }),
        then(resolve) {
          const rows = tableRows().filter((row) =>
            Object.entries(filters).every(([key, value]) => row[key] === value)
          );
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
        insert(payload) {
          return {
            select() {
              return {
                single: async () => {
                  const row = { id: `copied-${state.inserts.length + 1}`, ...payload };
                  state.roles.push(row);
                  state.inserts.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        delete() {
          return {
            eq(column, value) {
              filters[column] = value;
              return {
                eq(nextColumn, nextValue) {
                  filters[nextColumn] = nextValue;
                  state.deletes.push({ ...filters });
                  state.roles = state.roles.filter((row) =>
                    !Object.entries(filters).every(([key, filterValue]) => row[key] === filterValue)
                  );
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
      return query;
    },
    async rpc(name, params) {
      state.rpcs.push({ name, params });
      const key = `${name}:${params.p_category_id}:${params.p_subcategory || ''}:${params.p_has_access}`;
      const legacyKey = `${name}:${params.p_category_id}:${params.p_subcategory || ''}`;
      return rpcFailures[key] || rpcFailures[legacyKey]
        ? { data: null, error: { message: 'rpc failed' } }
        : { data: {}, error: null };
    },
  };
  return { db, state };
}

test('role copy payload retains configurable settings but resets protected/default fields', () => {
  const copied = buildRoleCopyPayload({
    name: 'Member',
    description: 'A role',
    excluded_features: ['content.resources'],
    show_tours: false,
    show_bookmarks: false,
    default_landing_page: 'Dashboard',
    layout_theme: 'bare_home',
    requires_effective_from_date: true,
    is_tenant_admin: true,
    badge_image_url: 'https://example.test/badge.png',
    badge_background_colour: '#123456',
    badge_text_colour: '#ffffff',
    segment_values: ['Gold'],
    max_members: 10,
    is_default: true,
    is_system: true,
    is_admin: true,
  }, ['Member', 'Member (Copy)']);

  assert.equal(copied.name, 'Member (Copy) 2');
  assert.deepEqual(copied.excluded_features, ['content.resources']);
  assert.deepEqual(copied.segment_values, ['Gold']);
  assert.equal(copied.max_members, 10);
  assert.equal(copied.badge_image_url, 'https://example.test/badge.png');
  assert.equal(copied.is_tenant_admin, true);
  assert.equal(copied.is_default, false);
  assert.equal(copied.is_system, false);
  assert.equal(copied.is_admin, false);
});

test('resource copy changes include only source role exclusions at category and subcategory level', () => {
  const changes = getResourceAccessCopyChanges([
    {
      id: 'category-1',
      excluded_role_ids: ['source-role', 'other-role'],
      subcategory_excluded_role_ids: { Private: ['source-role'], Public: ['other-role'] },
    },
    { id: 'category-2', excluded_role_ids: [], subcategory_excluded_role_ids: {} },
  ], 'source-role');
  assert.deepEqual(changes, [
    { categoryId: 'category-1', hasAccess: false },
    { categoryId: 'category-1', subcategory: 'Private', hasAccess: false },
  ]);
});

test('role duplication scopes source and destination to the caller tenant and leaves source untouched', async () => {
  const source = {
    id: 'source-role',
    tenant_id: TENANT_A,
    name: 'Member',
    excluded_features: ['content.resources'],
    is_default: true,
    is_system: true,
    show_tours: false,
    segment_values: ['Gold'],
  };
  const { db, state } = makeFakeDb({
    roles: [source, { id: 'other-role', tenant_id: TENANT_B, name: 'Elsewhere' }],
    members: [{ id: 'member-1', tenant_id: TENANT_A, role_id: 'source-role' }],
    categories: [{
      id: 'category-1',
      tenant_id: TENANT_A,
      excluded_role_ids: ['source-role'],
      subcategory_excluded_role_ids: { Private: ['source-role'] },
    }],
  });

  const result = await duplicateTenantRole({ db, tenantId: TENANT_A, sourceRoleId: 'source-role' });
  assert.equal(result.status, 201);
  assert.equal(result.body.role.tenant_id, TENANT_A);
  assert.equal(result.body.role.name, 'Member (Copy)');
  assert.equal(result.body.role.is_default, false);
  assert.equal(result.body.role.is_system, false);
  assert.equal(result.body.role.is_admin, false);
  assert.deepEqual(source.excluded_features, ['content.resources'], 'source RBAC settings are unchanged');
  assert.deepEqual(
    state.members,
    [{ id: 'member-1', tenant_id: TENANT_A, role_id: 'source-role' }],
    'members remain assigned only to the source role'
  );
  assert.equal(state.rpcs.length, 2);
  assert.ok(state.rpcs.every(({ params }) => params.p_tenant_id === TENANT_A));
  assert.ok(state.rpcs.every(({ params }) => params.p_role_id === result.body.role.id));
});

test('a role ID from another tenant is not found and creates no copy', async () => {
  const { db, state } = makeFakeDb({
    roles: [{ id: 'foreign-role', tenant_id: TENANT_B, name: 'Foreign' }],
  });
  const result = await duplicateTenantRole({ db, tenantId: TENANT_A, sourceRoleId: 'foreign-role' });
  assert.equal(result.status, 404);
  assert.equal(state.inserts.length, 0);
});

test('failed resource copy rolls back its access changes and removes the incomplete role', async () => {
  const { db, state } = makeFakeDb({
    roles: [{ id: 'source-role', tenant_id: TENANT_A, name: 'Member' }],
    categories: [{
      id: 'category-1',
      tenant_id: TENANT_A,
      excluded_role_ids: ['source-role'],
      subcategory_excluded_role_ids: { Private: ['source-role'] },
    }],
    rpcFailures: {
      'resource_category_set_subcategory_role_access:category-1:Private': true,
    },
  });
  const result = await duplicateTenantRole({ db, tenantId: TENANT_A, sourceRoleId: 'source-role' });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /copy resource visibility/i);
  assert.equal(state.deletes.length, 1);
  assert.equal(state.roles.some((role) => role.id.startsWith('copied-')), false);
  assert.equal(state.rpcs.length, 3, 'one access copy, one failure, one rollback');
  assert.equal(state.rpcs.at(-1).params.p_has_access, true);
});

test('failed rollback keeps the copied role available for administrator repair', async () => {
  const { db, state } = makeFakeDb({
    roles: [{ id: 'source-role', tenant_id: TENANT_A, name: 'Member' }],
    categories: [
      { id: 'category-1', tenant_id: TENANT_A, excluded_role_ids: ['source-role'] },
      { id: 'category-2', tenant_id: TENANT_A, excluded_role_ids: ['source-role'] },
    ],
    rpcFailures: {
      'resource_category_set_role_access:category-2::false': true,
      'resource_category_set_role_access:category-1::true': true,
    },
  });
  const result = await duplicateTenantRole({ db, tenantId: TENANT_A, sourceRoleId: 'source-role' });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /administrator must review/i);
  assert.equal(result.body.copyRoleId, 'copied-1');
  assert.equal(state.deletes.length, 0, 'copy is not deleted while its ID remains in access data');
  assert.equal(state.roles.some((role) => role.id === result.body.copyRoleId), true);
});

test('role duplication access requires authentication, tenant context, and Role Management/admin access', async () => {
  assert.deepEqual(
    await checkRoleDuplicationAccess({ isAuthenticated: false }, { hasAdminAccess: async () => true }),
    { ok: false, status: 401, error: 'Authentication required' }
  );
  assert.deepEqual(
    await checkRoleDuplicationAccess({ isAuthenticated: true }, { hasAdminAccess: async () => true }),
    { ok: false, status: 400, error: 'Tenant context not available' }
  );
  assert.deepEqual(
    await checkRoleDuplicationAccess({ isAuthenticated: true, tenantId: TENANT_A }, { hasAdminAccess: async () => false }),
    { ok: false, status: 403, error: 'Role Management access required' }
  );
  assert.deepEqual(
    await checkRoleDuplicationAccess({ isAuthenticated: true, tenantId: TENANT_A, roleId: 'admin-role' }, { hasAdminAccess: async () => true }),
    { ok: true }
  );
});