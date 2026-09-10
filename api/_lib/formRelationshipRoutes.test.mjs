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
    createService: ({ tenantId }) => ({
      eligibleDefinitions: async (formId, authorAccess) => {
        dispatched = true;
        assert.equal(tenantId, 'tenant-1');
        assert.equal(formId, 'form-1');
        assert.deepEqual(authorAccess, { isTenantUser: false, roleId: 'role-1' });
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