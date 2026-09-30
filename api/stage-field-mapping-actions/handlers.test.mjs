import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageFieldMappingActionsHandler } from './index.js';
import { createStageFieldMappingActionHandler } from './[id].js';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const FORM_ID = 'form-1';
const FOREIGN_FORM_ID = 'form-foreign';
const STAGE_ID = 'stage-review';
const FOREIGN_STAGE_ID = 'stage-other';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeState() {
  return {
    form: [
      {
        id: FORM_ID,
        tenant_id: TENANT_ID,
        fields: [{ id: 'source-name', name: 'source_name', label: 'Name' }],
      },
      {
        id: FOREIGN_FORM_ID,
        tenant_id: OTHER_TENANT_ID,
        fields: [{ id: 'source-name', name: 'source_name', label: 'Name' }],
      },
    ],
    form_due_diligence_config: [
      {
        id: 'config-1',
        form_id: FORM_ID,
        tenant_id: TENANT_ID,
        workflow_stages: [{ id: STAGE_ID, label: 'Review' }],
      },
    ],
    preference_field: [
      {
        id: 'member-text',
        tenant_id: TENANT_ID,
        entity_scope: 'member',
        is_active: true,
        field_type: 'text',
      },
      {
        id: 'member-inactive',
        tenant_id: TENANT_ID,
        entity_scope: 'member',
        is_active: false,
        field_type: 'text',
      },
      {
        id: 'foreign-member-text',
        tenant_id: OTHER_TENANT_ID,
        entity_scope: 'member',
        is_active: true,
        field_type: 'text',
      },
    ],
    stage_field_mapping_action: [],
  };
}

class Query {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.filters = [];
    this.operation = 'select';
    this.payload = null;
    this.limitCount = null;
  }

  select(columns = '*') {
    this.columns = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column, values) {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  order() {
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  single() {
    return Promise.resolve(this.execute(true));
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute(false)).then(resolve, reject);
  }

  execute(single) {
    if (this.table === 'preference_field') {
      if (this.state.preferenceError) return { data: null, error: this.state.preferenceError };
      const supported = new Set([
        'id', 'tenant_id', 'entity_scope', 'is_active', 'field_type',
        ...(this.state.optionalPreferenceColumns || []),
      ]);
      const unknown = this.columns?.split(',').map(column => column.trim())
        .find(column => column !== '*' && !supported.has(column));
      if (unknown) return { data: null, error: { code: '42703', message: `column preference_field.${unknown} does not exist` } };
    }
    const rows = this.state[this.table] || [];
    const matches = rows.filter((row) => this.filters.every((filter) => (
      filter.kind === 'in'
        ? filter.values.includes(row[filter.column])
        : row[filter.column] === filter.value
    )));

    if (this.operation === 'insert') {
      const inserted = Array.isArray(this.payload) ? this.payload : [this.payload];
      const persisted = inserted.map((row, index) => ({
        id: row.id || `mapping-${rows.length + index + 1}`,
        ...clone(row),
      }));
      rows.push(...persisted);
      return { data: single ? persisted[0] : persisted, error: null };
    }
    if (this.operation === 'update') {
      matches.forEach((row) => Object.assign(row, clone(this.payload)));
      return { data: single ? (matches[0] || null) : matches, error: null };
    }
    if (this.operation === 'delete') {
      this.state[this.table] = rows.filter((row) => !matches.includes(row));
      return { data: null, error: null };
    }

    const data = this.limitCount === 1 ? matches.slice(0, 1) : matches;
    if (single && !data[0]) return { data: null, error: { code: 'PGRST116' } };
    const projected = !this.columns || this.columns === '*' ? data : data.map(row => (
      Object.fromEntries(this.columns.split(',').map(column => column.trim()).map(column => [column, row[column]]))
    ));
    return { data: single ? projected[0] : projected, error: null };
  }
}

function makeSupabase(state) {
  return {
    from(table) {
      return new Query(state, table);
    },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function makeHandler(state, {
  authenticated = true,
  admin = true,
  feature = false,
  tenantId = TENANT_ID,
  roleId = 'role-1',
  memberExcludedFeatures = [],
} = {}) {
  const dependencies = {
    supabase: makeSupabase(state),
    getTenantContext: async () => ({
      tenantId,
      roleId,
      isAuthenticated: authenticated,
      memberExcludedFeatures,
      // This distinguishes tenant users from ordinary members in the
      // permission regression cases.
      ...(admin ? { tenantUserId: 'tenant-user-1' } : {}),
    }),
    hasAdminAccess: async () => admin,
    hasFeatureAccess: async () => feature,
  };
  return {
    list: createStageFieldMappingActionsHandler(dependencies),
    item: createStageFieldMappingActionHandler(dependencies),
  };
}

const validMemberMapping = {
  source_type: 'form_field',
  source_field_id: 'source-name',
  target_type: 'core',
  target_field: 'first_name',
};

const validMemberCustomMapping = {
  source_type: 'form_field',
  source_field_id: 'source-name',
  target_type: 'custom',
  target_field: 'member-text',
};

async function postMemberMapping(state, mapping = validMemberMapping) {
  const handlers = makeHandler(state);
  const response = makeResponse();
  await handlers.list({
    method: 'POST',
    body: {
      form_id: FORM_ID,
      due_diligence_stage_id: STAGE_ID,
      target_entity: 'member',
      field_mappings: [mapping],
    },
  }, response);
  return response;
}

test('ordinary members cannot create or read stage mapping configuration', async () => {
  const state = makeState();
  const handlers = makeHandler(state, { admin: false, feature: false });
  const response = makeResponse();

  await handlers.list({ method: 'POST', body: {} }, response);

  assert.equal(response.statusCode, 403);
  const readResponse = makeResponse();
  await handlers.list({ method: 'GET', query: { formId: FORM_ID } }, readResponse);
  assert.equal(readResponse.statusCode, 403);
  assert.equal(state.stage_field_mapping_action.length, 0);
});

test('excluded tenant admins cannot bypass the config permission gate', async () => {
  const state = makeState();
  const handlers = makeHandler(state, {
    admin: false,
    feature: false,
    roleId: 'excluded-admin-role',
    memberExcludedFeatures: ['forms.due-diligence-config'],
  });
  const response = makeResponse();

  await handlers.list({
    method: 'POST',
    body: {
      form_id: FORM_ID,
      due_diligence_stage_id: STAGE_ID,
      target_entity: 'member',
      field_mappings: [validMemberMapping],
    },
  }, response);

  assert.equal(response.statusCode, 403);
  assert.equal(state.stage_field_mapping_action.length, 0);
});

test('unauthenticated callers are rejected before touching the database', async () => {
  const state = makeState();
  const handlers = makeHandler(state, { authenticated: false, admin: false });
  const response = makeResponse();

  await handlers.list({ method: 'GET', query: { formId: FORM_ID } }, response);

  assert.equal(response.statusCode, 401);
});

test('foreign forms and stages cannot be used to create mapping actions', async () => {
  const foreignFormState = makeState();
  const foreignFormResponse = makeResponse();
  await makeHandler(foreignFormState).list({
    method: 'POST',
    body: {
      form_id: FOREIGN_FORM_ID,
      due_diligence_stage_id: STAGE_ID,
      target_entity: 'member',
      field_mappings: [validMemberMapping],
    },
  }, foreignFormResponse);

  const foreignStageState = makeState();
  const foreignStageResponse = makeResponse();
  await makeHandler(foreignStageState).list({
    method: 'POST',
    body: {
      form_id: FORM_ID,
      due_diligence_stage_id: FOREIGN_STAGE_ID,
      target_entity: 'member',
      field_mappings: [validMemberMapping],
    },
  }, foreignStageResponse);

  assert.equal(foreignFormResponse.statusCode, 404);
  assert.equal(foreignStageResponse.statusCode, 404);
  assert.equal(foreignFormState.stage_field_mapping_action.length, 0);
  assert.equal(foreignStageState.stage_field_mapping_action.length, 0);
});

test('existing actions cannot be updated when their form or stage is foreign', async () => {
  const foreignFormState = makeState();
  foreignFormState.stage_field_mapping_action.push({
    id: 'foreign-form-action',
    tenant_id: TENANT_ID,
    form_id: FOREIGN_FORM_ID,
    due_diligence_stage_id: STAGE_ID,
    target_entity: 'organization',
    field_mappings: [{
      source_type: 'form_field',
      source_field_id: 'source-name',
      target_type: 'core',
      target_field: 'name',
    }],
  });
  const foreignFormResponse = makeResponse();
  await makeHandler(foreignFormState).item({
    method: 'PATCH',
    query: { id: 'foreign-form-action' },
    body: { target_entity: 'member', field_mappings: [validMemberMapping] },
  }, foreignFormResponse);

  const foreignStageState = makeState();
  foreignStageState.stage_field_mapping_action.push({
    id: 'foreign-stage-action',
    tenant_id: TENANT_ID,
    form_id: FORM_ID,
    due_diligence_stage_id: FOREIGN_STAGE_ID,
    target_entity: 'organization',
    field_mappings: [{
      source_type: 'form_field',
      source_field_id: 'source-name',
      target_type: 'core',
      target_field: 'name',
    }],
  });
  const foreignStageResponse = makeResponse();
  await makeHandler(foreignStageState).item({
    method: 'PATCH',
    query: { id: 'foreign-stage-action' },
    body: { target_entity: 'member', field_mappings: [validMemberMapping] },
  }, foreignStageResponse);

  assert.equal(foreignFormResponse.statusCode, 404);
  assert.equal(foreignStageResponse.statusCode, 404);
  assert.equal(foreignFormState.stage_field_mapping_action[0].target_entity, 'organization');
  assert.equal(foreignStageState.stage_field_mapping_action[0].target_entity, 'organization');
});

test('target_entity persists on create and update through both handlers', async () => {
  const state = makeState();
  const postResponse = await postMemberMapping(state);
  assert.equal(postResponse.statusCode, 201);
  assert.equal(postResponse.body.field_mapping_action.target_entity, 'member');
  const id = postResponse.body.field_mapping_action.id;
  assert.equal(state.stage_field_mapping_action[0].target_entity, 'member');

  const updateResponse = makeResponse();
  await makeHandler(state).item({
    method: 'PATCH',
    query: { id },
    body: {
      target_entity: 'member',
      field_mappings: [validMemberCustomMapping],
    },
  }, updateResponse);

  assert.equal(updateResponse.statusCode, 200);
  assert.equal(updateResponse.body.field_mapping_action.target_entity, 'member');
  assert.equal(state.stage_field_mapping_action[0].target_entity, 'member');
  assert.deepEqual(state.stage_field_mapping_action[0].field_mappings, [validMemberCustomMapping]);
});

test('foreign and inactive member custom fields are rejected at the API boundary', async () => {
  for (const targetField of ['foreign-member-text', 'member-inactive']) {
    const state = makeState();
    const response = await postMemberMapping(state, {
      ...validMemberCustomMapping,
      target_field: targetField,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(state.stage_field_mapping_action.length, 0);
  }
});

test('mapping source ids must belong to the selected form', async () => {
  const state = makeState();
  const response = await postMemberMapping(state, {
    ...validMemberMapping,
    source_field_id: 'source-from-another-form',
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Source field does not belong to this form/);
  assert.equal(state.stage_field_mapping_action.length, 0);
});

test('schema-aware mock rejects unknown preference projections', async () => {
  for (const column of ['read_only', 'is_calculated', 'formula']) {
    const result = await makeSupabase(makeState()).from('preference_field').select(`id, ${column}`);
    assert.equal(result.error.code, '42703');
  }
});

for (const entity of ['member', 'organization']) {
  for (const type of ['custom', 'core']) {
    test(`${entity} ${type} mappings create, update and reopen on the established schema`, async () => {
      const state = makeState();
      state.preference_field[0].entity_scope = entity;
      if (type === 'core') state.preferenceError = { code: 'XX000', message: 'Must not query definitions' };
      const mapping = {
        ...validMemberCustomMapping, target_type: type,
        target_field: type === 'custom' ? 'member-text' : entity === 'member' ? 'first_name' : 'name',
      };
      const handlers = makeHandler(state);
      const created = makeResponse();
      await handlers.list({ method: 'POST', body: {
        form_id: FORM_ID, due_diligence_stage_id: STAGE_ID, target_entity: entity, field_mappings: [mapping],
      } }, created);
      assert.equal(created.statusCode, 201);
      const id = created.body.field_mapping_action.id;
      const updatedMapping = { ...mapping, source_type: 'static', static_value: 'Reviewed value' };
      for (const method of ['PUT', 'PATCH']) {
        const updated = makeResponse();
        await handlers.item({ method, query: { id }, body: { field_mappings: [updatedMapping] } }, updated);
        assert.equal(updated.statusCode, 200);
      }
      const reopened = makeResponse();
      await handlers.item({ method: 'GET', query: { id } }, reopened);
      assert.deepEqual(reopened.body.field_mapping_action.field_mappings, [updatedMapping]);
      const listed = makeResponse();
      await handlers.list({ method: 'GET', query: { formId: FORM_ID, stageId: STAGE_ID } }, listed);
      assert.deepEqual(listed.body.field_mapping_actions[0].field_mappings, [updatedMapping]);
    });
  }
}

for (const invalid of [
  { label: 'missing', remove: true },
  { label: 'foreign', tenant_id: OTHER_TENANT_ID },
  { label: 'wrong scope', entity_scope: 'organization' },
  { label: 'inactive', is_active: false },
  { label: 'unsupported', field_type: 'file' },
  ...['read_only', 'readonly', 'is_readonly', 'is_calculated', 'calculated', 'is_computed', 'formula', 'calculation']
    .map(column => ({ label: column, [column]: column === 'formula' || column === 'calculation' ? '1 + 1' : true })),
  { label: 'query error', error: { code: 'XX000', message: 'Database unavailable' } },
  { label: 'schema error', error: { code: '42703', message: 'Unexpected schema failure' } },
]) {
  test(`invalid custom target (${invalid.label}) fails closed on create and update`, async () => {
    const state = makeState();
    const created = await postMemberMapping(state);
    const id = created.body.field_mapping_action.id;
    const before = clone(state.stage_field_mapping_action);
    if (invalid.remove) state.preference_field = [];
    else Object.assign(state.preference_field[0], invalid);
    state.optionalPreferenceColumns = Object.keys(invalid);
    state.preferenceError = invalid.error;
    const expectedStatus = invalid.error ? 500 : 400;
    const response = await postMemberMapping(state, validMemberCustomMapping);
    assert.equal(response.statusCode, expectedStatus);
    for (const method of ['PUT', 'PATCH']) {
      const updated = makeResponse();
      await makeHandler(state).item({
        method, query: { id }, body: { field_mappings: [validMemberCustomMapping] },
      }, updated);
      assert.equal(updated.statusCode, expectedStatus);
    }
    assert.deepEqual(state.stage_field_mapping_action, before);
  });
}
