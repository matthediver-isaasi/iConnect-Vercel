import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME = '1';
const { __setRoleAccessOverlayForTests } = await import('../../_lib/roleVisibility.js');
__setRoleAccessOverlayForTests([]);
const { createMemberCpdPointsHandler } = await import('./cpd-points.js');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('allows a member with canonical CPD access to read only their own tenant-scoped history', async () => {
  let request;
  let resolved;
  let resolverOptions;
  const handler = createMemberCpdPointsHandler({
    db: {},
    getSessionMember: async () => ({
      id: 'member-1',
      tenant_id: 'tenant-1',
      role_id: 'role-1',
      member_excluded_features: [],
    }),
    getTenantContext: async () => { throw new Error('admin fallback should not run'); },
    resolveMemberExclusions: async (input, db, options) => {
      resolved = input;
      resolverOptions = options;
      return [];
    },
    loadMemberCpdPointsHistory: async (input) => {
      request = input;
      return { balance: 4, items: [], total: 0, page: 2, pageSize: 10 };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1', page: '2', pageSize: '10' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(resolved, { roleId: 'role-1', memberExcludedFeatures: [] });
  assert.deepEqual(resolverOptions, { requireRole: true });
  assert.deepEqual(request, { tenantId: 'tenant-1', memberId: 'member-1', page: 2, pageSize: 10 });
});

for (const [description, exclusion] of [
  ['canonical feature', 'cpd.member_cpd'],
  ['parent CPD module', 'cpd'],
  ['legacy CPD page alias', 'page_CpdPoints'],
]) {
  test(`denies self-service history when the ${description} is excluded`, async () => {
    let queried = false;
    const handler = createMemberCpdPointsHandler({
      db: {},
      getSessionMember: async () => ({
        id: 'member-1',
        tenant_id: 'tenant-1',
        role_id: 'role-1',
        member_excluded_features: [],
      }),
      resolveMemberExclusions: async () => [exclusion],
      getTenantContext: async () => null,
      loadMemberCpdPointsHistory: async () => { queried = true; },
    });
    const res = response();
    await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(queried, false);
  });
}

test('denies another member and does not query the ledger', async () => {
  let queried = false;
  const handler = createMemberCpdPointsHandler({
    db: {},
    getSessionMember: async () => ({ id: 'member-2', tenant_id: 'tenant-1' }),
    getTenantContext: async () => ({ tenantId: 'tenant-1' }),
    hasAdminAccess: async () => false,
    loadMemberCpdPointsHistory: async () => { queried = true; },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(queried, false);
});

for (const [description, member, resolver] of [
  [
    'role id is missing',
    { id: 'member-1', tenant_id: 'tenant-1', role_id: null },
    async () => { throw new Error('resolver must not run without a role'); },
  ],
  [
    'role cannot be resolved',
    { id: 'member-1', tenant_id: 'tenant-1', role_id: 'dangling-role' },
    async () => { throw new Error('role not found'); },
  ],
]) {
  test(`denies self-service history when the ${description}`, async () => {
    let queried = false;
    const handler = createMemberCpdPointsHandler({
      db: {},
      getSessionMember: async () => member,
      resolveMemberExclusions: resolver,
      getTenantContext: async () => null,
      loadMemberCpdPointsHistory: async () => { queried = true; },
    });
    const res = response();
    await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(queried, false);
  });
}

test('denies self-service history when the stored role row is dangling', async () => {
  let queried = false;
  const db = {
    from(table) {
      assert.equal(table, 'role');
      return {
        select() { return this; },
        eq() { return this; },
        async single() {
          return {
            data: null,
            error: { code: 'PGRST116', message: 'The result contains 0 rows' },
          };
        },
      };
    },
  };
  const handler = createMemberCpdPointsHandler({
    db,
    getSessionMember: async () => ({
      id: 'member-1',
      tenant_id: 'tenant-1',
      role_id: 'dangling-role',
    }),
    getTenantContext: async () => null,
    loadMemberCpdPointsHistory: async () => { queried = true; },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(queried, false);
});

test('preserves the independent admin fallback when self role resolution fails', async () => {
  let request;
  const handler = createMemberCpdPointsHandler({
    db: {},
    getSessionMember: async () => ({
      id: 'member-1',
      tenant_id: 'self-tenant',
      role_id: 'dangling-role',
    }),
    resolveMemberExclusions: async () => { throw new Error('role not found'); },
    getTenantContext: async () => ({ tenantId: 'admin-tenant' }),
    hasAdminAccess: async () => true,
    loadMemberCpdPointsHistory: async (input) => {
      request = input;
      return { balance: 0, items: [], total: 0, page: 1, pageSize: 20 };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(request.tenantId, 'admin-tenant');
});

test('allows an authorized tenant admin and preserves the context tenant', async () => {
  let request;
  const handler = createMemberCpdPointsHandler({
    db: {},
    getSessionMember: async () => null,
    resolveMemberExclusions: async () => {
      throw new Error('admin history must not depend on member feature access');
    },
    getTenantContext: async () => ({ tenantId: 'tenant-admin' }),
    hasAdminAccess: async () => true,
    loadMemberCpdPointsHistory: async (input) => {
      request = input;
      return { balance: 0, items: [], total: 0, page: 1, pageSize: 20 };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: { memberId: 'member-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(request.tenantId, 'tenant-admin');
});