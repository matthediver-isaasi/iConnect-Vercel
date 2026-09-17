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
  rpcError,
} from './departmentCurrentSet.js';

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
    rows() {
      const rows = tables[this.table] || [];
      return rows.filter(row => this.filters.every(filter => {
        if (filter.kind === 'eq') return row?.[filter.column] === filter.value;
        if (filter.kind === 'is') return row?.[filter.column] === filter.value;
        return filter.values.includes(row?.[filter.column]);
      }));
    }
    result() {
      const rows = this.rows();
      return {
        data: this.table === 'department_current_set_config'
          ? (rows[0] || null)
          : (this.table === 'form' || this.table === 'custom_object_relationship_definition'
            || this.table === 'custom_object_definition' || this.table === 'preference_field'
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
    organization_id: 'org-a',
  }]);
  assert.equal(db.queries.some(query => query.table === 'organization'), false);
  assert.equal(db.queries.some(query => query.table === 'custom_object_relationship_definition'
    && query.filters.some(filter => filter.column === 'relationship_key')), false);
});

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
