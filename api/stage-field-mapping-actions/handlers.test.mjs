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

  select() {
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
    return { data, error: null };
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
