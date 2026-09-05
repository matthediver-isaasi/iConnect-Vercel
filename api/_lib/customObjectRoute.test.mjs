import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomObjectRouteHandler } from './customObjectRoute.js';
import { CustomObjectHttpError } from './customObjectService.js';

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

test('record route selects atomic create when initial relationships are supplied', async () => {
  const handler = createCustomObjectRouteHandler('resource', {
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
    createCustomObjectService: () => ({
      createRecordWithRelationships: async (objectId, body) => ({ objectId, atomic: true, body }),
    }),
  });
  const res = response();
  await handler({
    method: 'POST',
    query: { objectId: 'object-1', resource: 'records' },
    body: { data: {}, initial_relationships: [] },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.atomic, true);
});

test('initial relationship candidate route dispatches the new-record side contract', async () => {
  const handler = createCustomObjectRouteHandler('resource', {
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
    createCustomObjectService: () => ({
      initialRelationshipCandidates: async (objectId, query) => ({ objectId, side: query.newRecordSide }),
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: { objectId: 'object-1', resource: 'initial-relationship-candidates', definitionId: 'definition-1', newRecordSide: 'target' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { objectId: 'object-1', side: 'target' });
});

test('relationship filter option route stays on the record-grant authorization path', async () => {
  const handler = createCustomObjectRouteHandler('resource', {
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
    createCustomObjectService: () => ({
      relationshipFilterOptions: async (objectId, query) => ({
        objectId,
        fieldId: query.fieldId,
      }),
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: {
      objectId: 'object-1',
      resource: 'relationship-filter-options',
      fieldId: 'relationship:definition-1:source',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    objectId: 'object-1',
    fieldId: 'relationship:definition-1:source',
  });
});

test('export is a record-data route and field permission resources remain schema-managed', async () => {
  const calls = [];
  const dependencies = {
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1' }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (_roleId, feature) => feature === 'admin.data-studio',
    createCustomObjectService: () => ({
      exportRecords: async (objectId, query) => { calls.push(['export', objectId, query]); return { columns: [] }; },
      listFieldPermissions: async (objectId) => { calls.push(['list-fields', objectId]); return { data: [] }; },
    }),
  };
  const exportRes = response();
  await createCustomObjectRouteHandler('resource', dependencies)({
    method: 'GET', query: { objectId: 'object-1', resource: 'export', search: 'safe' },
  }, exportRes);
  assert.equal(exportRes.statusCode, 200);
  assert.deepEqual(calls[0], ['export', 'object-1', { objectId: 'object-1', resource: 'export', search: 'safe' }]);

  const fieldRes = response();
  await createCustomObjectRouteHandler('resource', dependencies)({
    method: 'GET', query: { objectId: 'object-1', resource: 'field-permissions' },
  }, fieldRes);
  assert.equal(fieldRes.statusCode, 200);
  assert.deepEqual(calls[1], ['list-fields', 'object-1']);
});

test('collection reads reach service record-grant fallback when schema view is unavailable', async () => {
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
    createCustomObjectService: ({ canViewSchema, canManageSchema }) => ({
      listObjects: async () => ({ canViewSchema, canManageSchema, fallbackReached: true }),
    }),
  });
  const res = response();
  await handler({ method: 'GET', query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    canViewSchema: false,
    canManageSchema: false,
    fallbackReached: true,
  });
  assert.ok(checked.includes('admin.data-studio'));
});

test('object and field reads reach service object-grant fallback without schema features', async () => {
  const dependencies = {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
    createCustomObjectService: ({ canViewSchema, canManageSchema }) => ({
      getObject: async (objectId) => ({
        objectId, canViewSchema, canManageSchema, fallbackReached: true,
      }),
      listFields: async (objectId) => ({
        objectId, canViewSchema, canManageSchema, fallbackReached: true,
      }),
    }),
  };
  const objectRes = response();
  await createCustomObjectRouteHandler('object', dependencies)({
    method: 'GET',
    query: { objectId: 'object-1' },
  }, objectRes);
  assert.equal(objectRes.statusCode, 200);
  assert.deepEqual(objectRes.payload, {
    objectId: 'object-1',
    canViewSchema: false,
    canManageSchema: false,
    fallbackReached: true,
  });

  const fieldRes = response();
  await createCustomObjectRouteHandler('resource', dependencies)({
    method: 'GET',
    query: { objectId: 'object-1', resource: 'fields' },
  }, fieldRes);
  assert.equal(fieldRes.statusCode, 200);
  assert.deepEqual(fieldRes.payload, {
    objectId: 'object-1',
    canViewSchema: false,
    canManageSchema: false,
    fallbackReached: true,
  });
});

test('schema feature access does not promote a portal role to object-grant administrator', async () => {
  const handler = createCustomObjectRouteHandler('object', {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', memberId: 'member-1', roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => true,
    createCustomObjectService: ({ isAdmin, canViewSchema, canManageSchema }) => {
      assert.equal(isAdmin, false);
      assert.equal(canViewSchema, true);
      assert.equal(canManageSchema, true);
      return {
        getObject: async () => {
          throw new CustomObjectHttpError(403, 'Access denied');
        },
      };
    },
  });
  const res = response();
  await handler({ method: 'GET', query: { objectId: 'object-1' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'Access denied');
});

test('view access permits catalogue GET but not schema mutation without manage access', async () => {
  const dependencies = {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async (_roleId, feature) => feature === 'admin.data-studio',
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

test('resource routes expose entity picker and pass explicit archive verification body', async () => {
  const calls = [];
  const dependencies = {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
    createCustomObjectService: () => ({
      entityPicker: async (objectId, query) => {
        calls.push(['picker', objectId, query.definitionId, query.recordId, query.side]);
        return { data: [], page: 1, pageSize: 25, total: 0 };
      },
      archiveRelationship: async (objectId, edgeId, body) => {
        calls.push(['archive', objectId, edgeId, body]);
        return { id: edgeId, archived_at: 'now' };
      },
    }),
  };
  const pickerRes = response();
  await createCustomObjectRouteHandler('resource', dependencies)({
    method: 'GET',
    query: {
      objectId: 'object-1',
      resource: 'entity-picker',
      definitionId: 'definition-1',
      recordId: 'record-1',
      side: 'source',
    },
  }, pickerRes);
  assert.equal(pickerRes.statusCode, 200);

  const archiveRes = response();
  await createCustomObjectRouteHandler('item', dependencies)({
    method: 'DELETE',
    query: {
      objectId: 'object-1', resource: 'relationships', resourceId: 'edge-1',
    },
    body: { routed_side: 'target', routed_record_id: 'record-1' },
  }, archiveRes);
  assert.deepEqual(calls, [
    ['picker', 'object-1', 'definition-1', 'record-1', 'source'],
    ['archive', 'object-1', 'edge-1', {
      routed_side: 'target', routed_record_id: 'record-1',
    }],
  ]);
});

test('entity picker route returns service validation errors for arbitrary endpoint parameters', async () => {
  const handler = createCustomObjectRouteHandler('resource', {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1',
    }),
    hasAdminAccess: async () => false,
    hasFeatureAccess: async () => false,
    createCustomObjectService: () => ({
      entityPicker: async (_objectId, query) => {
        if (query.kind || query.customObjectId) {
          throw new CustomObjectHttpError(
            400,
            'Picker endpoint type is derived from definitionId and side',
          );
        }
        return {};
      },
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: {
      objectId: 'object-1',
      resource: 'entity-picker',
      kind: 'member',
      customObjectId: 'forged',
    },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /derived from definitionId/);
});

test('existing generic routes dispatch core relationship discovery, rows, picker, and mutations', async () => {
  const calls = [];
  const dependencies = {
    getTenantContext: async () => ({
      isAuthenticated: true, tenantId: 'tenant-1', tenantUserId: 'admin-1',
    }),
    hasAdminAccess: async () => true,
    createCustomObjectService: () => ({
      listCoreRelationshipDefinitions: async (kind, recordId) => {
        calls.push(['definitions', kind, recordId]);
        return { data: [] };
      },
      listCoreRelationships: async (kind, recordId, query) => {
        calls.push(['rows', kind, recordId, query.definitionId]);
        return { data: [] };
      },
      coreEntityPicker: async (kind, recordId, query) => {
        calls.push(['picker', kind, recordId, query.definitionId]);
        return { data: [] };
      },
      createCoreRelationship: async (kind, recordId, body) => {
        calls.push(['create', kind, recordId, body.related_record_id]);
        return { id: 'edge-1' };
      },
      archiveCoreRelationship: async (kind, recordId, edgeId) => {
        calls.push(['archive', kind, recordId, edgeId]);
        return { id: edgeId };
      },
    }),
  };
  const resourceHandler = createCustomObjectRouteHandler('resource', dependencies);
  const itemHandler = createCustomObjectRouteHandler('item', dependencies);
  const requests = [
    { handler: resourceHandler, request: { method: 'GET', query: { objectId: 'core', resource: 'relationship-definitions', kind: 'member', recordId: 'member-1' } } },
    { handler: resourceHandler, request: { method: 'GET', query: { objectId: 'core', resource: 'relationships', kind: 'member', recordId: 'member-1', definitionId: 'definition-1' } } },
    { handler: resourceHandler, request: { method: 'GET', query: { objectId: 'core', resource: 'entity-picker', kind: 'member', recordId: 'member-1', definitionId: 'definition-1' } } },
    { handler: resourceHandler, request: { method: 'POST', query: { objectId: 'core', resource: 'relationships', kind: 'member', recordId: 'member-1' }, body: { related_record_id: 'record-1' } } },
    { handler: itemHandler, request: { method: 'DELETE', query: { objectId: 'core', resource: 'relationships', resourceId: 'edge-1', kind: 'member', recordId: 'member-1' } } },
  ];
  for (const { handler, request } of requests) {
    const res = response();
    await handler(request, res);
    assert.ok([200, 201].includes(res.statusCode));
  }
  assert.deepEqual(calls, [
    ['definitions', 'member', 'member-1'],
    ['rows', 'member', 'member-1', 'definition-1'],
    ['picker', 'member', 'member-1', 'definition-1'],
    ['create', 'member', 'member-1', 'record-1'],
    ['archive', 'member', 'member-1', 'edge-1'],
  ]);
});