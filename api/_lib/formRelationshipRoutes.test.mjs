import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFormRelationshipDiscoveryHandler,
  createPublicFormRelationshipOptionsHandler,
} from './formRelationshipRoutes.js';

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test('discovery handler requires an authenticated administrator and form scope', async () => {
  let dispatched = false;
  const handler = createFormRelationshipDiscoveryHandler({
    db: {},
    getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-1' }),
    hasAdminAccess: async () => true,
    createService: ({ tenantId }) => ({
      eligibleDefinitions: async (formId) => {
        dispatched = true;
        assert.equal(tenantId, 'tenant-1');
        assert.equal(formId, 'form-1');
        return { data: [{ id: 'definition-1' }] };
      },
    }),
  });
  const res = response();
  await handler({ method: 'GET', query: { formId: 'form-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(dispatched, true);

  const denied = response();
  await createFormRelationshipDiscoveryHandler({
    db: {},
    getTenantContext: async () => ({ isAuthenticated: false }),
  })({ method: 'GET', query: {} }, denied);
  assert.equal(denied.statusCode, 401);
});

test('public options handler checks saved active form access before option dispatch', async () => {
  const calls = [];
  const handler = createPublicFormRelationshipOptionsHandler({
    db: {},
    resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
    resolveFormAccess: async ({ tenantId, policy }) => {
      calls.push(['access', tenantId, policy]);
      return { allowed: true };
    },
    createService: ({ tenantId }) => ({
      loadForm: async (input) => {
        calls.push(['form', tenantId, input]);
        return { is_active: true, access_policy: { mode: 'public' } };
      },
      relationshipOptions: async (input) => {
        calls.push(['options', input]);
        return { data: [{ id: 'record-1', label: 'One' }], total: 1, page: 1, pageSize: 25 };
      },
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: { slug: 'application', fieldId: 'field-1', organizationId: 'org-1' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data[0].label, 'One');
  assert.deepEqual(calls[0], ['form', 'tenant-1', { slug: 'application', activeOnly: true }]);
  assert.equal(calls[2][0], 'options');
});

test('public options handler scopes a relationship child to its persisted repeatable container', async () => {
  let optionInput = null;
  const handler = createPublicFormRelationshipOptionsHandler({
    db: {},
    resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
    resolveFormAccess: async () => ({ allowed: true }),
    createService: () => ({
      loadForm: async () => ({
        id: 'form-1', is_active: true, access_policy: { mode: 'public' },
        fields: [{
          id: 'workplaces', type: 'repeatable_rows',
          child_fields: [
            { id: 'org', type: 'organisation_dropdown' },
            { id: 'department', type: 'relationship_dropdown', parent_field_id: 'org' },
          ],
        }],
      }),
      relationshipOptions: async (input) => {
        optionInput = input;
        return { data: [], total: 0, page: 1, pageSize: 25 };
      },
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: {
      slug: 'application', containerFieldId: 'workplaces',
      fieldId: 'department', organizationId: 'org-1',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(optionInput.form.fields.map((field) => field.id), ['org', 'department']);

  const forged = response();
  await handler({
    method: 'GET',
    query: {
      slug: 'application', containerFieldId: 'workplaces',
      fieldId: 'forged', organizationId: 'org-1',
    },
  }, forged);
  assert.equal(forged.statusCode, 404);
});