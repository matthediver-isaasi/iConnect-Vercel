import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomObjectRouteHandler } from './customObjectRoute.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('dedicated route rejects unauthenticated requests before service dispatch', async () => {
  let serviceCreated = false;
  const handler = createCustomObjectRouteHandler('collection', {
    getTenantContext: async () => ({ isAuthenticated: false }),
    hasAdminAccess: async () => false,
    createCustomObjectService: () => {
      serviceCreated = true;
      return {};
    },
  });
  const res = response();
  await handler({ method: 'GET', query: {}, body: null }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error, 'Authentication required');
  assert.equal(serviceCreated, false);
});

test('dedicated collection route dispatches server-authenticated object creation', async () => {
  const calls = [];
  const handler = createCustomObjectRouteHandler('collection', {
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      tenantUserId: 'admin-1',
    }),
    hasAdminAccess: async () => true,
    createCustomObjectService: ({ context, isAdmin }) => {
      assert.equal(context.tenantId, 'tenant-1');
      assert.equal(isAdmin, true);
      return {
        createObject: async (body) => {
          calls.push(body);
          return { id: 'object-1', object_key: body.object_key };
        },
      };
    },
  });
  const res = response();
  await handler({
    method: 'POST',
    query: {},
    body: { object_key: 'asset', tenant_id: 'forged' },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(calls, [{ object_key: 'asset', tenant_id: 'forged' }]);
  assert.deepEqual(res.payload, { id: 'object-1', object_key: 'asset' });
});

test('dedicated nested route dispatches object-scoped record reads', async () => {
  const handler = createCustomObjectRouteHandler('item', {
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      memberId: 'member-1',
      roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    createCustomObjectService: () => ({
      getRecord: async (objectId, recordId) => ({ objectId, recordId }),
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: { objectId: 'object-1', resource: 'records', resourceId: 'record-1' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { objectId: 'object-1', recordId: 'record-1' });
});

test('schema catalogue access is denied directly when the view page is excluded', async () => {
  let serviceCreated = false;
  const checked = [];
  const handler = createCustomObjectRouteHandler('collection', {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (_roleId, feature) => {
      checked.push(feature);
      return false;
    },
    createCustomObjectService: () => {
      serviceCreated = true;
      return {};
    },
  });
  const res = response();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(serviceCreated, false);
  assert.ok(checked.includes('data.custom-objects'));
});

test('view access permits catalogue GET but not schema mutation without manage access', async () => {
  const dependencies = {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (_roleId, feature) => feature === 'data.custom-objects',
    createCustomObjectService: ({ canViewSchema, canManageSchema }) => ({
      listObjects: async () => ({ canViewSchema, canManageSchema }),
      createObject: async () => ({ unexpected: true }),
    }),
  };
  const getRes = response();
  await createCustomObjectRouteHandler('collection', dependencies)(
    { method: 'GET', query: {} },
    getRes,
  );
  assert.equal(getRes.statusCode, 200);
  assert.deepEqual(getRes.payload, { canViewSchema: true, canManageSchema: false });

  const postRes = response();
  await createCustomObjectRouteHandler('collection', dependencies)(
    { method: 'POST', query: {}, body: {} },
    postRes,
  );
  assert.equal(postRes.statusCode, 403);
});

test('portal admin cannot bypass an explicitly excluded manage-data-model feature', async () => {
  let serviceCreated = false;
  const handler = createCustomObjectRouteHandler('collection', {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', memberId: 'member-1', roleId: 'admin-role',
    }),
    hasAdminAccess: async () => true,
    hasFeatureAccess: async (_roleId, feature) =>
      feature !== 'data.custom-objects.manage-data-model',
    createCustomObjectService: () => {
      serviceCreated = true;
      return {};
    },
  });
  const res = response();
  await handler({ method: 'POST', query: {}, body: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(serviceCreated, false);
});

test('member-level hierarchical exclusions deny schema access even when the role allows it', async () => {
  let serviceCreated = false;
  const handler = createCustomObjectRouteHandler('collection', {
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      memberId: 'member-1',
      roleId: 'role-1',
      memberExcludedFeatures: ['data.custom-objects'],
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
    createCustomObjectService: () => {
      serviceCreated = true;
      return {};
    },
  });
  const res = response();
  await handler({ method: 'POST', query: {}, body: {} }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(serviceCreated, false);
});