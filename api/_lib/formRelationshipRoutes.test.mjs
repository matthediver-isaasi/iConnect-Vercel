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

function discoveryDb(seed) {
  const tables = structuredClone(seed);
  const calls = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orders = [];
    }
    select(projection) {
      this.projection = projection;
      calls.push({ table: this.table, operation: 'select' });
      return this;
    }
    eq(column, value) {
      this.filters.push(row => row[column] === value);
      return this;
    }
    in(column, values) {
      this.filters.push(row => values.includes(row[column]));
      return this;
    }
    order(column, { ascending = true } = {}) {
      this.orders.push({ column, ascending });
      return this;
    }
    execute() {
      const rows = (tables[this.table] || []).filter(row => this.filters.every(filter => filter(row)));
      rows.sort((left, right) => {
        for (const order of this.orders) {
          if (left[order.column] === right[order.column]) continue;
          const result = left[order.column] < right[order.column] ? -1 : 1;
          return order.ascending ? result : -result;
        }
        return 0;
      });
      return { data: structuredClone(rows), error: null };
    }
    async maybeSingle() {
      const result = this.execute();
      return { ...result, data: result.data[0] || null };
    }
    then(resolve, reject) {
      return Promise.resolve(this.execute()).then(resolve, reject);
    }
  }
  return {
    calls,
    from(table) {
      calls.push({ table, operation: 'from' });
      return new Query(table);
    },
  };
}

function surveyDb({ assignments = [], assignment = null, snapshot = null, snapshotError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      const result = table === 'event_survey_assignment'
        ? { data: assignment || assignments, error: null }
        : { data: snapshot, error: snapshotError };
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        limit() { return chain; },
        maybeSingle() { return Promise.resolve(result); },
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
      };
      return chain;
    },
  };
}

test('discovery handler requires an authenticated administrator and form scope', async () => {
  let dispatched = false;
  const handler = createFormRelationshipDiscoveryHandler({
    db: {},
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      tenantUserId: null,
      roleId: 'role-1',
    }),
    hasAdminAccess: async () => true,
    hasFeatureAccess: async () => false,
    createService: ({ tenantId }) => ({
      eligibleDefinitions: async (formId, authorAccess) => {
        dispatched = true;
        assert.equal(tenantId, 'tenant-1');
        assert.equal(formId, 'form-1');
        assert.deepEqual(authorAccess, {
          isTenantUser: false,
          roleId: 'role-1',
          canViewSchema: false,
          canManageSchema: false,
        });
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

test('discovery route resolves trusted schema access before the real service and filters publication metadata', async () => {
  const seed = {
    form: [
      { id: 'form-1', tenant_id: 'tenant-1', is_active: true },
      { id: 'foreign-form', tenant_id: 'tenant-2', is_active: true },
    ],
    custom_object_relationship_definition: [
      {
        id: 'organization-object',
        tenant_id: 'tenant-1',
        relationship_key: 'organization_object',
        status: 'active',
        source_kind: 'organization',
        source_custom_object_id: null,
        target_kind: 'custom_object',
        target_custom_object_id: 'object-1',
        show_on_source: true,
        show_on_target: true,
        source_label: 'Object',
        target_label: 'Organization',
      },
      {
        id: 'object-object',
        tenant_id: 'tenant-1',
        relationship_key: 'object_object',
        status: 'active',
        source_kind: 'custom_object',
        source_custom_object_id: 'object-1',
        target_kind: 'custom_object',
        target_custom_object_id: 'object-2',
        show_on_source: true,
        show_on_target: true,
        source_label: 'Object 2',
        target_label: 'Object 1',
      },
    ],
    custom_object_definition: [
      {
        id: 'object-1',
        tenant_id: 'tenant-1',
        object_key: 'object_one',
        singular_label: 'Object One',
        plural_label: 'Object Ones',
        primary_display_field_id: 'object-1-primary',
        status: 'active',
        archived_at: null,
      },
      {
        id: 'object-2',
        tenant_id: 'tenant-1',
        object_key: 'object_two',
        singular_label: 'Object Two',
        plural_label: 'Object Twos',
        primary_display_field_id: 'object-2-primary',
        status: 'active',
        archived_at: null,
      },
      {
        id: 'standalone-object',
        tenant_id: 'tenant-1',
        object_key: 'standalone',
        singular_label: 'Standalone',
        plural_label: 'Standalone Objects',
        primary_display_field_id: 'standalone-primary',
        status: 'active',
        archived_at: null,
      },
    ],
    preference_field: [
      {
        id: 'object-1-primary', tenant_id: 'tenant-1', custom_object_id: 'object-1',
        entity_scope: 'custom_object', is_active: true, name: 'name', label: 'Name',
        field_type: 'text',
      },
      {
        id: 'object-1-filter', tenant_id: 'tenant-1', custom_object_id: 'object-1',
        entity_scope: 'custom_object', is_active: true, name: 'filter', label: 'Filter',
        field_type: 'text',
      },
      {
        id: 'object-2-primary', tenant_id: 'tenant-1', custom_object_id: 'object-2',
        entity_scope: 'custom_object', is_active: true, name: 'name', label: 'Name',
        field_type: 'text',
      },
      {
        id: 'standalone-primary', tenant_id: 'tenant-1', custom_object_id: 'standalone-object',
        entity_scope: 'custom_object', is_active: true, name: 'name', label: 'Name',
        field_type: 'text',
      },
    ],
    custom_object_role_permission: [{
      tenant_id: 'tenant-1',
      custom_object_id: 'object-1',
      role_id: 'restricted-author',
      can_view_records: true,
    }],
    custom_object_field_role_permission: [
      {
        tenant_id: 'tenant-1', custom_object_id: 'object-1', role_id: 'schema-author',
        field_id: 'object-1-filter', access_level: 'none',
      },
      {
        tenant_id: 'tenant-1', custom_object_id: 'object-2', role_id: 'schema-author',
        field_id: 'object-2-primary', access_level: 'none',
      },
      {
        tenant_id: 'tenant-1', custom_object_id: 'object-1', role_id: 'restricted-author',
        field_id: 'object-1-filter', access_level: 'none',
      },
      {
        tenant_id: 'tenant-1', custom_object_id: 'object-1', role_id: 'primary-denied-author',
        field_id: 'object-1-primary', access_level: 'none',
      },
    ],
  };
  const featureAccess = async (roleId, feature) => (
    (roleId === 'schema-author' && feature === 'admin.data-studio')
    || (roleId === 'schema-manager' && feature === 'data.custom-objects.manage-data-model')
    || (roleId === 'primary-denied-author' && feature === 'admin.data-studio')
  );
  async function invoke(context, query = { formId: 'form-1' }, admin = true) {
    const db = discoveryDb(seed);
    const handler = createFormRelationshipDiscoveryHandler({
      db,
      getTenantContext: async () => context,
      hasAdminAccess: async () => admin,
      hasFeatureAccess: featureAccess,
    });
    const res = response();
    await handler({ method: 'GET', query }, res);
    return { db, res };
  }

  const schemaAuthor = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'schema-author',
  });
  assert.equal(schemaAuthor.res.statusCode, 200);
  assert.deepEqual(schemaAuthor.res.payload.custom_objects.map(object => object.id), [
    'object-1', 'standalone-object',
  ]);
  assert.deepEqual(
    schemaAuthor.res.payload.custom_objects.find(object => object.id === 'object-1').fields
      .map(field => field.id),
    ['object-1-primary'],
  );
  assert.deepEqual(schemaAuthor.res.payload.data.map(item => item.discovery_key).sort(), [
    'organization-object:source', 'organization-object:target',
  ]);
  assert.equal(
    schemaAuthor.db.calls.some(call => call.table === 'custom_object_role_permission'),
    false,
  );

  const schemaManager = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'schema-manager',
  });
  assert.equal(schemaManager.res.statusCode, 200);
  assert.deepEqual(schemaManager.res.payload.custom_objects.map(object => object.id), [
    'object-1', 'object-2', 'standalone-object',
  ]);

  const restrictedAuthor = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'restricted-author',
  });
  assert.equal(restrictedAuthor.res.statusCode, 200);
  assert.deepEqual(restrictedAuthor.res.payload.custom_objects.map(object => object.id), ['object-1']);
  assert.deepEqual(restrictedAuthor.res.payload.data.map(item => item.discovery_key).sort(), [
    'organization-object:source', 'organization-object:target',
  ]);

  const noSchema = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'no-schema-author',
  });
  assert.equal(noSchema.res.statusCode, 200);
  assert.deepEqual(noSchema.res.payload.custom_objects, []);
  assert.deepEqual(noSchema.res.payload.data, []);

  const memberExclusion = await invoke({
    isAuthenticated: true,
    tenantId: 'tenant-1',
    roleId: 'schema-author',
    memberExcludedFeatures: ['admin.data-studio'],
  });
  assert.equal(memberExclusion.res.statusCode, 200);
  assert.deepEqual(memberExclusion.res.payload.custom_objects, []);

  const primaryDenied = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'primary-denied-author',
  });
  assert.equal(primaryDenied.res.statusCode, 200);
  assert.deepEqual(primaryDenied.res.payload.custom_objects.map(object => object.id), [
    'object-2', 'standalone-object',
  ]);
  assert.deepEqual(primaryDenied.res.payload.data, []);

  const spoofed = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'no-schema-author',
  }, {
    formId: 'form-1',
    canViewSchema: 'true',
    canManageSchema: 'true',
    isTenantUser: 'true',
  });
  assert.equal(spoofed.res.statusCode, 200);
  assert.deepEqual(spoofed.res.payload.custom_objects, []);

  const tenantUser = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', tenantUserId: 'tenant-user-1',
  });
  assert.equal(tenantUser.res.statusCode, 200);
  assert.deepEqual(tenantUser.res.payload.custom_objects.map(object => object.id), [
    'object-1', 'object-2', 'standalone-object',
  ]);
  assert.deepEqual(
    tenantUser.res.payload.custom_objects.find(object => object.id === 'object-1').fields
      .map(field => field.id),
    ['object-1-filter', 'object-1-primary'],
  );
  assert.deepEqual(tenantUser.res.payload.data.map(item => item.discovery_key).sort(), [
    'object-object:source', 'object-object:target',
    'organization-object:source', 'organization-object:target',
  ]);

  const foreignForm = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'schema-author',
  }, { formId: 'foreign-form' });
  assert.equal(foreignForm.res.statusCode, 404);

  const schemaCannotBypassAdmin = await invoke({
    isAuthenticated: true, tenantId: 'tenant-1', roleId: 'schema-author',
  }, { formId: 'form-1' }, false);
  assert.equal(schemaCannotBypassAdmin.res.statusCode, 403);
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

test('public row-source options use POST body dependencies and persisted form scope', async () => {
  let optionInput;
  const objectId = '00000000-0000-4000-8000-000000000001';
  const primaryId = '00000000-0000-4000-8000-000000000002';
  const containerId = '00000000-0000-4000-8000-000000000003';
  const fieldId = '00000000-0000-4000-8000-000000000004';
  const dependencyId = '00000000-0000-4000-8000-000000000005';
  const handler = createPublicFormRelationshipOptionsHandler({
    db: {},
    resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
    resolveFormAccess: async () => ({ allowed: true }),
    createService: () => ({
      loadForm: async () => ({
        is_active: true,
        access_policy: { mode: 'public' },
        fields: [{
          id: containerId,
          type: 'repeatable_rows',
          children: [
            { id: dependencyId, type: 'text' },
            {
              id: fieldId,
              type: 'relationship_dropdown',
              option_source: {
                version: 1,
                kind: 'records',
                custom_object_id: objectId,
                primary_display_field_id: primaryId,
                filters: [],
              },
            },
          ],
        }],
      }),
      relationshipOptions: async (input) => {
        optionInput = input;
        return { data: [], total: 0, page: 2, pageSize: 10 };
      },
    }),
  });
  const res = response();
  await handler({
    method: 'POST',
    query: { slug: 'application' },
    body: {
      fieldId,
      containerFieldId: containerId,
      dependencyAnswers: { [dependencyId]: 'Acme' },
      all: true,
      page: 2,
      pageSize: 10,
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(optionInput.dependencyAnswers, { [dependencyId]: 'Acme' });
  assert.deepEqual(optionInput.query, {
    fieldId,
    containerFieldId: containerId,
    dependencyAnswers: { [dependencyId]: 'Acme' },
    all: true,
    page: 2,
    pageSize: 10,
  });
});

test('public options reject malformed saved sources without legacy dispatch', async () => {
  let dispatched = false;
  const handler = createPublicFormRelationshipOptionsHandler({
    db: {},
    resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
    resolveFormAccess: async () => ({ allowed: true }),
    createService: () => ({
      loadForm: async () => ({
        is_active: true,
        access_policy: { mode: 'public' },
        fields: [{
          id: 'rows',
          type: 'repeatable_rows',
          children: [{
            id: 'picker',
            type: 'relationship_dropdown',
            parent_field_id: 'parent',
            relationship_definition_id: 'legacy-definition',
            option_source: {
              version: 1,
              kind: 'records',
              custom_object_id: 'forged',
              primary_display_field_id: 'forged',
              filters: [],
            },
          }],
        }],
      }),
      async relationshipOptions() { dispatched = true; return {}; },
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: {
      slug: 'application',
      containerFieldId: 'rows',
      fieldId: 'picker',
      parentRecordId: 'parent-1',
    },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(dispatched, false);
});

test('published survey row-source options use the active immutable snapshot, not mutable form fields', async () => {
  const objectId = '00000000-0000-4000-8000-000000000001';
  const primaryId = '00000000-0000-4000-8000-000000000002';
  const containerId = '00000000-0000-4000-8000-000000000003';
  const fieldId = '00000000-0000-4000-8000-000000000004';
  const source = label => ({
    id: fieldId,
    label,
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: objectId,
      primary_display_field_id: primaryId,
      filters: [],
    },
  });
  const draftFields = [{
    id: containerId,
    type: 'repeatable_rows',
    children: [source('Unpublished picker')],
  }];
  const publishedFields = [{
    id: containerId,
    type: 'repeatable_rows',
    children: [source('Published picker')],
  }];
  const db = surveyDb({
    assignment: {
      id: 'assignment-1',
      status: 'active',
      access_mode: 'public',
      opens_at: null,
      closes_at: null,
    },
    snapshot: {
      fields: publishedFields,
      pages: [],
      visibility_rules: [],
      survey_settings: { respondent_mode: 'anonymous' },
      version_number: 3,
    },
  });
  let optionInput;
  const handler = createPublicFormRelationshipOptionsHandler({
    db,
    resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
    resolveFormAccess: async () => ({ allowed: true }),
    getSession: async () => null,
    getSessionMember: async () => null,
    createService: () => ({
      loadForm: async () => ({
        id: 'survey-1',
        tenant_id: 'tenant-1',
        is_active: true,
        form_type: 'survey',
        access_policy: { mode: 'public' },
        survey_settings: { status: 'published', current_version: 3 },
        fields: draftFields,
      }),
      relationshipOptions: async (input) => {
        optionInput = input;
        return { data: [], total: 0, page: 1, pageSize: 25 };
      },
    }),
  });
  const res = response();
  await handler({
    method: 'POST',
    query: { slug: 'survey' },
    body: {
      fieldId,
      containerFieldId: containerId,
      assignment_token: 'assignment-token',
      dependencyAnswers: {},
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(optionInput.form.fields[0].label, 'Published picker');
  assert.equal(optionInput.rootForm.fields[0].children[0].label, 'Published picker');
  assert.equal(optionInput.rootForm.survey_settings.current_version, 3);
  assert.deepEqual(db.calls, ['event_survey_assignment', 'survey_version']);
});

test('unpublished, assigned-direct, and snapshotless surveys fail closed before option dispatch', async () => {
  async function invoke(form, db) {
    let optionCalls = 0;
    const handler = createPublicFormRelationshipOptionsHandler({
      db,
      resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
      resolveFormAccess: async () => ({ allowed: true }),
      getSession: async () => null,
      createService: () => ({
        loadForm: async () => form,
        relationshipOptions: async () => { optionCalls += 1; return {}; },
      }),
    });
    const res = response();
    await handler({ method: 'GET', query: { slug: 'survey', fieldId: 'picker' } }, res);
    return { res, optionCalls };
  }

  const draftDb = surveyDb();
  const draft = await invoke({
    id: 'survey-1',
    tenant_id: 'tenant-1',
    is_active: true,
    form_type: 'survey',
    survey_settings: { status: 'draft', current_version: 1 },
  }, draftDb);
  assert.equal(draft.res.statusCode, 404);
  assert.equal(draft.optionCalls, 0);
  assert.deepEqual(draftDb.calls, []);

  const assignedDb = surveyDb({ assignments: [{ id: 'assignment-1' }] });
  const assigned = await invoke({
    id: 'survey-1',
    tenant_id: 'tenant-1',
    is_active: true,
    form_type: 'survey',
    survey_settings: { status: 'published', current_version: 1 },
  }, assignedDb);
  assert.equal(assigned.res.statusCode, 404);
  assert.equal(assigned.optionCalls, 0);
  assert.deepEqual(assignedDb.calls, ['event_survey_assignment']);

  const snapshotlessDb = surveyDb();
  const snapshotless = await invoke({
    id: 'survey-1',
    tenant_id: 'tenant-1',
    is_active: true,
    form_type: 'survey',
    survey_settings: { status: 'published', current_version: 2 },
  }, snapshotlessDb);
  assert.equal(snapshotless.res.statusCode, 404);
  assert.equal(snapshotless.optionCalls, 0);
  assert.deepEqual(snapshotlessDb.calls, ['event_survey_assignment', 'survey_version']);
});

test('legacy normal forms do not query survey tables', async () => {
  const db = surveyDb();
  let optionCalls = 0;
  const handler = createPublicFormRelationshipOptionsHandler({
    db,
    resolveTenantFromRequest: async () => ({ id: 'tenant-1' }),
    resolveFormAccess: async () => ({ allowed: true }),
    createService: () => ({
      loadForm: async () => ({
        id: 'form-1',
        is_active: true,
        form_type: 'form',
        access_policy: { mode: 'public' },
        fields: [],
      }),
      relationshipOptions: async ({ rootForm }) => {
        optionCalls += 1;
        assert.equal(rootForm.id, 'form-1');
        return { data: [], total: 0, page: 1, pageSize: 25 };
      },
    }),
  });
  const res = response();
  await handler({
    method: 'GET',
    query: { slug: 'application', fieldId: 'legacy-field', parentRecordId: 'parent-1' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(optionCalls, 1);
  assert.deepEqual(db.calls, []);
});