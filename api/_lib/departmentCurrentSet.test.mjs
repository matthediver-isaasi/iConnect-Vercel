import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCurrentSetFormValues,
  currentSetMetadata,
  DEPARTMENT_CURRENT_SET_METADATA_KEY,
  DepartmentCurrentSetError,
  DEPARTMENT_CURRENT_SET_FORM_ID,
  DEPARTMENT_CURRENT_SET_TENANT_ID,
  listDepartmentCurrentSetOptions,
  loadDepartmentCurrentSet,
  loadDepartmentCurrentSetOrganization,
  rpcError,
} from './departmentCurrentSet.js';
import { buildDepartmentCurrentSetCompatibilityContract } from './departmentCurrentSetCompatibility.js';
import currentSetHandler from '../public/form/current-set.js';

const config = {
  workforce_container_field_id: 'workforce',
  equipment_container_field_id: 'equipment',
};
const departmentId = '11111111-1111-4111-8111-111111111111';

test('current set needs complete metadata and both explicit arrays', () => {
  const values = {
    ...currentSetMetadata({ departmentId, version: 'version', completeSections: ['workforce', 'equipment'] }),
    workforce: [], equipment: [],
  };
  assert.deepEqual(assertCurrentSetFormValues({ values, configuration: config }), {
    departmentId, version: 'version', workforce: [], equipment: [],
  });
  assert.equal(values[DEPARTMENT_CURRENT_SET_METADATA_KEY].department_id, departmentId);
});

test('current set refuses omission so a failed/hidden section cannot clear', () => {
  assert.throws(() => assertCurrentSetFormValues({
    values: { workforce: [], [DEPARTMENT_CURRENT_SET_METADATA_KEY]: { department_id: departmentId, version: 'v', complete_sections: ['workforce'] } },
    configuration: config,
  }), error => error instanceof DepartmentCurrentSetError && error.code === 'CURRENT_SET_INCOMPLETE');
});

test('BNMS current-set integration has immutable destination identifiers', () => {
  assert.equal(DEPARTMENT_CURRENT_SET_FORM_ID, '8b6f44d3-83f8-449e-9496-b10b1dc28e5f');
  assert.equal(DEPARTMENT_CURRENT_SET_TENANT_ID, 'ff2df806-b321-4254-b651-3af11fccf1db');
});

test('transaction retry and deadlock failures return a clear current-set conflict', () => {
  for (const code of ['40001', '40P01']) {
    const error = rpcError({ code, message: 'deadlock detected' });
    assert.equal(error.status, 409);
    assert.equal(error.code, 'CURRENT_SET_CONFLICT');
    assert.match(error.message, /reload and review/i);
  }
});

const OPTION_FORM_ID = DEPARTMENT_CURRENT_SET_FORM_ID;
const OPTION_TENANT_ID = DEPARTMENT_CURRENT_SET_TENANT_ID;
const OPTION_MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const OPTION_OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const OPTION_RELATIONSHIP_ID = '44444444-4444-4444-8444-444444444444';
const OPTION_DEPARTMENT_ID = '55555555-5555-4555-8555-555555555555';
const OPTION_ARCHIVED_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_TENANT_ID = '77777777-7777-4777-8777-777777777777';

function makeOptionsDb({
  respondentEdges = [],
  respondentDefinition = {
    id: OPTION_RELATIONSHIP_ID,
    source_kind: 'custom_object',
    source_custom_object_id: OPTION_OBJECT_ID,
    target_kind: 'member',
    target_custom_object_id: null,
    status: 'active',
  },
  departmentDefinition = {
    id: OPTION_OBJECT_ID,
    primary_display_field_id: null,
  },
  records = [],
  form = {
    id: OPTION_FORM_ID,
    tenant_id: OPTION_TENANT_ID,
    is_active: true,
    require_authentication: true,
    access_policy: null,
    deactivate_at: null,
    deactivate_timezone: null,
  },
} = {}) {
  const tables = {
    department_current_set_config: [{
      tenant_id: OPTION_TENANT_ID,
      form_id: OPTION_FORM_ID,
      config: {
        respondent_relationship_id: OPTION_RELATIONSHIP_ID,
        respondent_field_key: 'is_current_respondent',
        department_object_id: OPTION_OBJECT_ID,
      },
    }],
    form: [form],
    custom_object_relationship: respondentEdges,
    custom_object_relationship_definition: [{
      ...respondentDefinition,
      tenant_id: OPTION_TENANT_ID,
    }],
    custom_object_definition: [{
      ...departmentDefinition,
      tenant_id: OPTION_TENANT_ID,
      status: 'active',
    }],
    custom_object_record: records,
    preference_field: [],
    organization: [],
  };
  const queries = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      queries.push(this);
    }
    select() { return this; }
    eq(column, value) { this.filters.push({ kind: 'eq', column, value }); return this; }
    is(column, value) { this.filters.push({ kind: 'is', column, value }); return this; }
    in(column, values) { this.filters.push({ kind: 'in', column, values }); return this; }
    limit(value) { this.limitValue = value; return this; }
    rows() {
      const rows = tables[this.table] || [];
      return rows.filter(row => this.filters.every(filter => {
        if (filter.kind === 'eq') return row?.[filter.column] === filter.value;
        if (filter.kind === 'is') return row?.[filter.column] === filter.value;
        return filter.values.includes(row?.[filter.column]);
      }));
    }
    result() {
      const allRows = this.rows();
      const rows = this.limitValue == null ? allRows : allRows.slice(0, this.limitValue);
      return {
        data: this.table === 'department_current_set_config'
          ? (rows[0] || null)
          : (this.table === 'form' || this.table === 'custom_object_relationship_definition'
            || this.table === 'custom_object_definition' || this.table === 'preference_field'
            || this.table === 'organization'
            ? (rows[0] || null) : rows),
        error: null,
      };
    }
    maybeSingle() { return Promise.resolve(this.result()); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  return {
    queries,
    from(table) { return new Query(table); },
  };
}

function optionDependencies(member = {
  id: OPTION_MEMBER_ID,
  tenant_id: OPTION_TENANT_ID,
  organization_id: 'org-a',
}) {
  return {
    req: { headers: {} },
    tenantId: OPTION_TENANT_ID,
    formId: OPTION_FORM_ID,
    getMember: async () => member,
    getActiveSession: async () => ({
      id: 'option-session',
      data: { memberId: member.id },
    }),
  };
}

test('current-set picker allows a true assigned Department from another organisation', async () => {
  const db = makeOptionsDb({
    respondentEdges: [{
      tenant_id: OPTION_TENANT_ID,
      relationship_definition_id: OPTION_RELATIONSHIP_ID,
      source_record_id: OPTION_DEPARTMENT_ID,
      target_record_id: OPTION_MEMBER_ID,
      field_values: { is_current_respondent: true },
      archived_at: null,
    }],
    records: [{
      tenant_id: OPTION_TENANT_ID,
      custom_object_id: OPTION_OBJECT_ID,
      id: OPTION_DEPARTMENT_ID,
      data: { department_name: 'Cross-organisation Department' },
      archived_at: null,
    }],
  });
  const options = await listDepartmentCurrentSetOptions({
    db, ...optionDependencies(),
  });
  assert.deepEqual(options, [{
    id: OPTION_DEPARTMENT_ID,
    label: 'Cross-organisation Department',
  }]);
  assert.equal(db.queries.some(query => query.table === 'organization'), false);
  assert.equal(db.queries.some(query => query.table === 'custom_object_relationship_definition'
    && query.filters.some(filter => filter.column === 'relationship_key')), false);
});

test('current-set identity resolves only one strict tenant-local organisation owner', async () => {
  const organizationId = '88888888-8888-4888-8888-888888888888';
  const rows = {
    custom_object_relationship_definition: [{
      id: OPTION_RELATIONSHIP_ID, tenant_id: OPTION_TENANT_ID,
      relationship_key: 'organisation', status: 'active', is_required: true,
      source_kind: 'custom_object', source_custom_object_id: OPTION_OBJECT_ID,
      target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one',
    }],
    custom_object_relationship: [{
      tenant_id: OPTION_TENANT_ID, relationship_definition_id: OPTION_RELATIONSHIP_ID,
      source_record_id: OPTION_DEPARTMENT_ID, target_record_id: organizationId, archived_at: null,
    }],
    organization: [{
      id: organizationId, tenant_id: OPTION_TENANT_ID, name: 'Identity Organisation',
    }],
  };
  const identityDb = makeIdentityDb(rows);
  assert.deepEqual(await loadDepartmentCurrentSetOrganization({
    db: identityDb, tenantId: OPTION_TENANT_ID, departmentId: OPTION_DEPARTMENT_ID,
    configuration: { department_object_id: OPTION_OBJECT_ID },
  }), {
    status: 'available', id: organizationId, name: 'Identity Organisation',
  });
  assert.deepEqual(identityDb.limits, [2, 2]);
});

function makeIdentityDb(tables, failures = {}) {
  const limits = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; }
    eq(column, value) { this.filters.push(['eq', column, value]); return this; }
    is(column, value) { this.filters.push(['is', column, value]); return this; }
    limit(value) { limits.push(value); this.limitValue = value; return this; }
    result() {
      if (failures[this.table] === 'throw') throw new Error('lookup failed');
      const allData = (tables[this.table] || []).filter(row => this.filters.every(([kind, column, value]) => (
        kind === 'is' ? row[column] === value : row[column] === value
      )));
      const data = this.limitValue == null ? allData : allData.slice(0, this.limitValue);
      return { data, error: failures[this.table] ? new Error('lookup failed') : null };
    }
    maybeSingle() {
      const result = this.result();
      return Promise.resolve({ ...result, data: result.data[0] || null });
    }
    then(resolve, reject) { return Promise.resolve().then(() => this.result()).then(resolve, reject); }
  }
  return { limits, from: table => new Query(table) };
}

test('current-set identity is unavailable for ambiguous, archived, cross-tenant, missing or failed ownership', async () => {
  const organizationId = '88888888-8888-4888-8888-888888888888';
  const definition = {
    id: OPTION_RELATIONSHIP_ID, tenant_id: OPTION_TENANT_ID,
    relationship_key: 'organisation', status: 'active', is_required: true,
    source_kind: 'custom_object', source_custom_object_id: OPTION_OBJECT_ID,
    target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one',
  };
  const edge = {
    tenant_id: OPTION_TENANT_ID, relationship_definition_id: OPTION_RELATIONSHIP_ID,
    source_record_id: OPTION_DEPARTMENT_ID, target_record_id: organizationId, archived_at: null,
  };
  const organization = { id: organizationId, tenant_id: OPTION_TENANT_ID, name: 'Owner' };
  const scenarios = [
    { custom_object_relationship_definition: [definition, { ...definition, id: '99999999-9999-4999-8999-999999999999' }] },
    { custom_object_relationship_definition: [definition], custom_object_relationship: [edge, { ...edge, target_record_id: '99999999-9999-4999-8999-999999999999' }] },
    { custom_object_relationship_definition: [definition], custom_object_relationship: [{ ...edge, archived_at: '2026-01-01' }], organization: [organization] },
    { custom_object_relationship_definition: [definition], custom_object_relationship: [edge], organization: [{ ...organization, tenant_id: OTHER_TENANT_ID }] },
    { custom_object_relationship_definition: [definition], custom_object_relationship: [edge], organization: [] },
  ];
  for (const tables of scenarios) {
    assert.deepEqual(await loadDepartmentCurrentSetOrganization({
      db: makeIdentityDb(tables), tenantId: OPTION_TENANT_ID,
      departmentId: OPTION_DEPARTMENT_ID,
      configuration: { department_object_id: OPTION_OBJECT_ID },
    }), { status: 'unavailable' });
  }
  assert.deepEqual(await loadDepartmentCurrentSetOrganization({
    db: makeIdentityDb({ custom_object_relationship_definition: [definition] }, {
      custom_object_relationship_definition: 'throw',
    }),
    tenantId: OPTION_TENANT_ID, departmentId: OPTION_DEPARTMENT_ID,
    configuration: { department_object_id: OPTION_OBJECT_ID },
  }), { status: 'unavailable' });
});

test('authorized current-set load resolves display identity only after the protected RPC', async () => {
  const organizationId = '88888888-8888-4888-8888-888888888888';
  const fields = [{
    id: 'workforce', type: 'repeatable_rows', min_rows: 0, max_rows: 20,
    first_row_required: false, child_fields: [{ id: 'staff', type: 'text' }],
  }, {
    id: 'equipment', type: 'repeatable_rows', min_rows: 0, max_rows: 100,
    first_row_required: false, child_fields: [
      { id: 'serial', type: 'text', required: true },
      { id: 'installed', type: 'date', required: true, date_precision: 'year' },
    ],
  }];
  const configuration = {
    department_object_id: OPTION_OBJECT_ID,
    workforce_container_field_id: 'workforce',
    equipment_container_field_id: 'equipment',
    workforce_fields: { staff: 'staff_group' },
    equipment_fields: { serial: 'serial_number', installed: 'year_installed' },
    required_blank_policy: {
      existing_equipment_blank_required_field_ids: ['serial', 'installed'],
      new_equipment_required_field_ids: ['serial', 'installed'],
    },
    equipment_hidden_preserve: {},
  };
  configuration.form_compatibility = buildDepartmentCurrentSetCompatibilityContract({
    form: { fields, visibility_rules: [] }, configuration,
  });
  const events = [];
  const db = makeLoadDb({
    events,
    configuration,
    fields,
    organizationId,
  });
  const loaded = await loadDepartmentCurrentSet({
    db,
    req: {},
    tenantId: OPTION_TENANT_ID,
    formId: OPTION_FORM_ID,
    departmentId: OPTION_DEPARTMENT_ID,
    getMember: async () => ({
      id: OPTION_MEMBER_ID, tenant_id: OPTION_TENANT_ID,
      // Deliberately different: identity must never derive from the member.
      organization_id: '99999999-9999-4999-8999-999999999999',
    }),
    getActiveSession: async () => ({
      id: 'session-1', data: { memberId: OPTION_MEMBER_ID },
    }),
    includeOrganization: true,
  });
  assert.deepEqual(loaded.organization, {
    status: 'available', id: organizationId, name: 'Graph Organisation',
  });
  assert.ok(events.indexOf('rpc') < events.indexOf('identity-definition'));
});

test('failed member, session, form access, and RPC authorization never query identity', async () => {
  const organizationId = '88888888-8888-4888-8888-888888888888';
  const { configuration, fields } = loadFixtureContract();
  const cases = [
    {
      name: 'member',
      getMember: async () => null,
      expectedCode: 'CURRENT_SET_AUTHENTICATION_REQUIRED',
    },
    {
      name: 'session',
      getMember: async () => ({ id: OPTION_MEMBER_ID, tenant_id: OPTION_TENANT_ID }),
      getActiveSession: async () => null,
      expectedCode: 'CURRENT_SET_AUTHENTICATION_REQUIRED',
    },
    {
      name: 'form access',
      getMember: async () => ({ id: OPTION_MEMBER_ID, tenant_id: OPTION_TENANT_ID }),
      getActiveSession: async () => ({ id: 'session-1', data: { memberId: OPTION_MEMBER_ID } }),
      formOverrides: { require_authentication: false },
      expectedCode: 'CURRENT_SET_AUTHORIZATION',
    },
    {
      name: 'RPC authorization',
      getMember: async () => ({ id: OPTION_MEMBER_ID, tenant_id: OPTION_TENANT_ID }),
      getActiveSession: async () => ({ id: 'session-1', data: { memberId: OPTION_MEMBER_ID } }),
      rpcError: {
        code: '42501',
        message: 'CURRENT_SET_AUTHORIZATION: respondent assignment is unavailable',
      },
      expectedCode: 'CURRENT_SET_AUTHORIZATION',
    },
  ];
  for (const scenario of cases) {
    const events = [];
    const db = makeLoadDb({
      events, configuration, fields, organizationId,
      formOverrides: scenario.formOverrides,
      rpcError: scenario.rpcError,
    });
    await assert.rejects(loadDepartmentCurrentSet({
      db,
      req: {},
      tenantId: OPTION_TENANT_ID,
      formId: OPTION_FORM_ID,
      departmentId: OPTION_DEPARTMENT_ID,
      getMember: scenario.getMember,
      getActiveSession: scenario.getActiveSession,
      includeOrganization: true,
    }), error => {
      assert.equal(error.code, scenario.expectedCode, scenario.name);
      return true;
    });
    assert.equal(events.includes('identity-definition'), false, scenario.name);
  }
});

test('unavailable identity preserves all authorized loaded arrays and metadata', async () => {
  const { configuration, fields } = loadFixtureContract();
  const metadata = {
    department_id: OPTION_DEPARTMENT_ID,
    version: 'version-without-identity',
    complete_sections: ['workforce', 'equipment'],
  };
  const loadedData = {
    department: { id: OPTION_DEPARTMENT_ID, label: 'Department label' },
    department_id: OPTION_DEPARTMENT_ID,
    version: metadata.version,
    complete_sections: metadata.complete_sections,
    form_values: {
      workforce: [{ _row_id: 'existing:workforce-1', staff: 'Clinical' }],
      equipment: [{ _row_id: 'existing:equipment-1', serial: '', installed: '' }],
      [DEPARTMENT_CURRENT_SET_METADATA_KEY]: metadata,
    },
  };
  const events = [];
  const db = makeLoadDb({
    events,
    configuration,
    fields,
    organizationId: '88888888-8888-4888-8888-888888888888',
    loadedData,
    identityTables: {
      custom_object_relationship_definition: [],
      custom_object_relationship: [],
      organization: [],
    },
  });
  const result = await loadDepartmentCurrentSet({
    db,
    req: {},
    tenantId: OPTION_TENANT_ID,
    formId: OPTION_FORM_ID,
    departmentId: OPTION_DEPARTMENT_ID,
    getMember: async () => ({ id: OPTION_MEMBER_ID, tenant_id: OPTION_TENANT_ID }),
    getActiveSession: async () => ({ id: 'session-1', data: { memberId: OPTION_MEMBER_ID } }),
    includeOrganization: true,
  });
  assert.deepEqual(result, {
    ...loadedData,
    organization: { status: 'unavailable' },
  });
  assert.strictEqual(result.form_values.workforce, loadedData.form_values.workforce);
  assert.strictEqual(result.form_values.equipment, loadedData.form_values.equipment);
  assert.strictEqual(
    result.form_values[DEPARTMENT_CURRENT_SET_METADATA_KEY],
    loadedData.form_values[DEPARTMENT_CURRENT_SET_METADATA_KEY],
  );
});

test('internal default load omits identity without any graph lookup', async () => {
  const { configuration, fields } = loadFixtureContract();
  const events = [];
  const db = makeLoadDb({
    events,
    configuration,
    fields,
    organizationId: '88888888-8888-4888-8888-888888888888',
  });
  const result = await loadDepartmentCurrentSet({
    db,
    req: {},
    tenantId: OPTION_TENANT_ID,
    formId: OPTION_FORM_ID,
    departmentId: OPTION_DEPARTMENT_ID,
    getMember: async () => ({ id: OPTION_MEMBER_ID, tenant_id: OPTION_TENANT_ID }),
    getActiveSession: async () => ({ id: 'session-1', data: { memberId: OPTION_MEMBER_ID } }),
  });
  assert.equal(Object.hasOwn(result, 'organization'), false);
  assert.equal(events.includes('identity-definition'), false);
  assert.deepEqual(events, ['rpc']);
});

test('HTTP current-set load opts into identity and forwards injected member and session dependencies', async () => {
  const organizationId = '88888888-8888-4888-8888-888888888888';
  const { configuration, fields } = loadFixtureContract();
  const events = [];
  const dependencyCalls = [];
  const db = makeLoadDb({ events, configuration, fields, organizationId });
  const req = {
    method: 'GET',
    query: { form_id: OPTION_FORM_ID, department_id: OPTION_DEPARTMENT_ID },
  };
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await currentSetHandler(req, response, {
    supabase: db,
    tenant: { id: OPTION_TENANT_ID },
    getSessionMember: async receivedReq => {
      dependencyCalls.push(['member', receivedReq]);
      return { id: OPTION_MEMBER_ID, tenant_id: OPTION_TENANT_ID };
    },
    getActiveSession: async receivedReq => {
      dependencyCalls.push(['session', receivedReq]);
      return { id: 'injected-session', data: { memberId: OPTION_MEMBER_ID } };
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.organization, {
    status: 'available',
    id: organizationId,
    name: 'Graph Organisation',
  });
  assert.deepEqual(dependencyCalls, [['member', req], ['session', req]]);
  assert.ok(events.indexOf('rpc') < events.indexOf('identity-definition'));
});

function loadFixtureContract() {
  const fields = [{
    id: 'workforce', type: 'repeatable_rows', min_rows: 0, max_rows: 20,
    first_row_required: false, child_fields: [{ id: 'staff', type: 'text' }],
  }, {
    id: 'equipment', type: 'repeatable_rows', min_rows: 0, max_rows: 100,
    first_row_required: false, child_fields: [
      { id: 'serial', type: 'text', required: true },
      { id: 'installed', type: 'date', required: true, date_precision: 'year' },
    ],
  }];
  const configuration = {
    department_object_id: OPTION_OBJECT_ID,
    workforce_container_field_id: 'workforce',
    equipment_container_field_id: 'equipment',
    workforce_fields: { staff: 'staff_group' },
    equipment_fields: { serial: 'serial_number', installed: 'year_installed' },
    required_blank_policy: {
      existing_equipment_blank_required_field_ids: ['serial', 'installed'],
      new_equipment_required_field_ids: ['serial', 'installed'],
    },
    equipment_hidden_preserve: {},
  };
  configuration.form_compatibility = buildDepartmentCurrentSetCompatibilityContract({
    form: { fields, visibility_rules: [] }, configuration,
  });
  return { configuration, fields };
}

function makeLoadDb({
  events, configuration, fields, organizationId, formOverrides = {},
  rpcError = null, loadedData = null, identityTables = null,
}) {
  const tables = {
    department_current_set_config: [{
      tenant_id: OPTION_TENANT_ID, form_id: OPTION_FORM_ID, config: configuration,
    }],
    form: [{
      id: OPTION_FORM_ID, tenant_id: OPTION_TENANT_ID, is_active: true,
      require_authentication: true, access_policy: null, fields, pages: [],
      visibility_rules: [], deactivate_at: null, deactivate_timezone: null,
      ...formOverrides,
    }],
    custom_object_relationship_definition: [{
      id: OPTION_RELATIONSHIP_ID, tenant_id: OPTION_TENANT_ID,
      relationship_key: 'organisation', status: 'active', is_required: true,
      source_kind: 'custom_object', source_custom_object_id: OPTION_OBJECT_ID,
      target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one',
    }],
    custom_object_relationship: [{
      tenant_id: OPTION_TENANT_ID, relationship_definition_id: OPTION_RELATIONSHIP_ID,
      source_record_id: OPTION_DEPARTMENT_ID, target_record_id: organizationId, archived_at: null,
    }],
    organization: [{
      id: organizationId, tenant_id: OPTION_TENANT_ID, name: 'Graph Organisation',
    }],
    ...(identityTables || {}),
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; }
    eq(column, value) { this.filters.push(['eq', column, value]); return this; }
    is(column, value) { this.filters.push(['is', column, value]); return this; }
    limit(value) { this.limitValue = value; return this; }
    result() {
      if (this.table === 'custom_object_relationship_definition') events.push('identity-definition');
      const all = (tables[this.table] || []).filter(row => this.filters.every(([, column, value]) => row[column] === value));
      return { data: this.limitValue == null ? all : all.slice(0, this.limitValue), error: null };
    }
    maybeSingle() {
      const result = this.result();
      return Promise.resolve({ data: result.data[0] || null, error: result.error });
    }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  return {
    from: table => new Query(table),
    rpc: async () => {
      events.push('rpc');
      if (rpcError) return { data: null, error: rpcError };
      return {
        data: loadedData || {
          department_id: OPTION_DEPARTMENT_ID,
          version: 'v1',
          form_values: { workforce: [], equipment: [] },
        },
        error: null,
      };
    },
  };
}

test('current-set picker excludes false or missing respondent assignments', async () => {
  const db = makeOptionsDb({
    respondentEdges: [
      {
        tenant_id: OPTION_TENANT_ID,
        relationship_definition_id: OPTION_RELATIONSHIP_ID,
        source_record_id: OPTION_DEPARTMENT_ID,
        target_record_id: OPTION_MEMBER_ID,
        field_values: { is_current_respondent: false },
        archived_at: null,
      },
      {
        tenant_id: OPTION_TENANT_ID,
        relationship_definition_id: OPTION_RELATIONSHIP_ID,
        source_record_id: OPTION_ARCHIVED_ID,
        target_record_id: OPTION_MEMBER_ID,
        field_values: {},
        archived_at: null,
      },
    ],
    records: [{
      tenant_id: OPTION_TENANT_ID,
      custom_object_id: OPTION_OBJECT_ID,
      id: OPTION_DEPARTMENT_ID,
      data: { department_name: 'Not assigned' },
      archived_at: null,
    }],
  });
  assert.deepEqual(await listDepartmentCurrentSetOptions({
    db, ...optionDependencies(),
  }), []);
  assert.equal(db.queries.some(query => query.table === 'custom_object_record'), false);
});

test('current-set picker excludes archived and cross-tenant Department records', async () => {
  const db = makeOptionsDb({
    respondentEdges: [
      {
        tenant_id: OPTION_TENANT_ID,
        relationship_definition_id: OPTION_RELATIONSHIP_ID,
        source_record_id: OPTION_DEPARTMENT_ID,
        target_record_id: OPTION_MEMBER_ID,
        field_values: { is_current_respondent: true },
        archived_at: null,
      },
      {
        tenant_id: OTHER_TENANT_ID,
        relationship_definition_id: OPTION_RELATIONSHIP_ID,
        source_record_id: OPTION_ARCHIVED_ID,
        target_record_id: OPTION_MEMBER_ID,
        field_values: { is_current_respondent: true },
        archived_at: null,
      },
      {
        tenant_id: OPTION_TENANT_ID,
        relationship_definition_id: OPTION_RELATIONSHIP_ID,
        source_record_id: OPTION_ARCHIVED_ID,
        target_record_id: OPTION_MEMBER_ID,
        field_values: { is_current_respondent: true },
        archived_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    records: [
      {
        tenant_id: OPTION_TENANT_ID,
        custom_object_id: OPTION_OBJECT_ID,
        id: OPTION_DEPARTMENT_ID,
        data: { department_name: 'Archived Department' },
        archived_at: '2026-01-01T00:00:00.000Z',
      },
      {
        tenant_id: OTHER_TENANT_ID,
        custom_object_id: OPTION_OBJECT_ID,
        id: OPTION_ARCHIVED_ID,
        data: { department_name: 'Wrong tenant Department' },
        archived_at: null,
      },
    ],
  });
  assert.deepEqual(await listDepartmentCurrentSetOptions({
    db, ...optionDependencies(),
  }), []);
});
