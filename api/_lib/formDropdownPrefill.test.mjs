import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FormDropdownPrefillError,
  resolveFormDropdownPrefill,
} from './formDropdownPrefill.js';
import { dropdownPrefillHandler } from '../public/form/dropdown-prefill.js';

function fakeDb(seed) {
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.ids = [];
    }
    select() { return this; }
    eq(column, value) {
      this.filters.push(row => row[column] === value);
      return this;
    }
    in(column, values) {
      this.filters.push(row => values.map(String).includes(String(row[column])));
      return this;
    }
    rows() {
      return structuredClone(seed[this.table] || [])
        .filter(row => this.filters.every(filter => filter(row)));
    }
    async maybeSingle() {
      return { data: this.rows()[0] || null, error: null };
    }
    then(resolve) {
      return Promise.resolve({ data: this.rows(), error: null }).then(resolve);
    }
  }
  return { from: table => new Query(table) };
}

const allowAccess = async () => ({ allowed: true });

function form(source, targets, extra = {}) {
  return {
    id: 'form-1',
    slug: 'apply',
    tenant_id: 'tenant-a',
    is_active: true,
    prefill_source: 'form_field',
    prefill_source_field_id: source.id,
    fields: [source, ...targets],
    ...extra,
  };
}

async function resolve(seed, input = {}) {
  return resolveFormDropdownPrefill({
    db: fakeDb(seed),
    req: {},
    tenantId: 'tenant-a',
    formId: 'form-1',
    recordId: input.recordId || 'record-1',
    sourceAnswers: input.sourceAnswers || {},
    resolveAccess: allowAccess,
    ...input,
  });
}

test('organisation dropdown prefill returns only saved core and custom mappings', async () => {
  const saved = form(
    { id: 'source', type: 'organisation_dropdown' },
    [
      { id: 'name-target', type: 'text', prefill_field: 'org:name' },
      { id: 'custom-target', type: 'text', prefill_field: 'org_custom:sector' },
      { id: 'unmapped', type: 'text' },
    ],
  );
  const result = await resolve({
    form: [saved],
    organization: [{
      id: 'record-1', tenant_id: 'tenant-a', name: 'Allowed', email: 'not exposed',
    }],
    preference_field: [{
      id: 'sector', tenant_id: 'tenant-a', entity_scope: 'organization', is_active: true,
    }],
    organization_preference_value: [{
      tenant_id: 'tenant-a', organization_id: 'record-1', field_id: 'sector', value: 'Education',
    }],
  });
  assert.deepEqual(result, {
    values: { 'name-target': 'Allowed', 'custom-target': 'Education' },
  });
});

test('organisation-group dropdown prefill supports core and custom values', async () => {
  const saved = form(
    { id: 'source', type: 'organisation_group_dropdown' },
    [
      { id: 'description', type: 'textarea', prefill_field: 'org_group:description' },
      { id: 'region', type: 'text', prefill_field: 'org_group_custom:region-field' },
    ],
  );
  const result = await resolve({
    form: [saved],
    organization_group: [{
      id: 'record-1', tenant_id: 'tenant-a', name: 'Group', description: 'Description',
    }],
    preference_field: [{
      id: 'region-field', tenant_id: 'tenant-a', entity_scope: 'organization_group', is_active: true,
    }],
    organization_group_preference_value: [{
      tenant_id: 'tenant-a', organization_group_id: 'record-1',
      field_id: 'region-field', value: 'North',
    }],
  });
  assert.deepEqual(result.values, { description: 'Description', region: 'North' });
});

test('wrapped custom-field targets return their persisted underlying type', async () => {
  const saved = form(
    { id: 'source', type: 'organisation_dropdown' },
    [{
      id: 'target',
      type: 'custom_field',
      custom_field_id: 'target-definition',
      prefill_field: 'org_custom:source-definition',
    }],
  );
  const result = await resolve({
    form: [saved],
    organization: [{ id: 'record-1', tenant_id: 'tenant-a', name: 'Allowed' }],
    preference_field: [
      {
        id: 'source-definition', tenant_id: 'tenant-a',
        entity_scope: 'organization', is_active: true, field_type: 'text',
      },
      {
        id: 'target-definition', tenant_id: 'tenant-a',
        entity_scope: 'member', is_active: true, field_type: 'checkbox',
      },
    ],
    organization_preference_value: [{
      tenant_id: 'tenant-a', organization_id: 'record-1',
      field_id: 'source-definition', value: '["A","B"]',
    }],
  });
  assert.deepEqual(result, {
    values: { target: '["A","B"]' },
    fieldTypes: { target: 'checkbox' },
  });
});

test('stale source, mapping order, and custom definitions fail closed', async () => {
  const cases = [
    form({ id: 'source', type: 'text' }, [{ id: 'target', prefill_field: 'org:name' }]),
    {
      ...form(
        { id: 'source', type: 'organisation_dropdown' },
        [{ id: 'target', prefill_field: 'org:name' }],
      ),
      fields: [
        { id: 'target', prefill_field: 'org:name' },
        { id: 'source', type: 'organisation_dropdown' },
      ],
    },
    form(
      { id: 'source', type: 'organisation_dropdown' },
      [{ id: 'target', prefill_field: 'org_custom:deleted' }],
    ),
  ];
  for (const saved of cases) {
    await assert.rejects(resolve({
      form: [saved],
      organization: [{ id: 'record-1', tenant_id: 'tenant-a', name: 'Name' }],
      preference_field: [],
    }), error => (
      error instanceof FormDropdownPrefillError && error.code === 'STALE_PREFILL_CONFIG'
    ));
  }
});

test('organisation conditional, static status, parent, and not-listed eligibility are reapplied', async () => {
  const source = {
    id: 'source',
    type: 'organisation_dropdown',
    organisation_group_parent_field_id: 'group',
    allowed_org_statuses: ['approved'],
    conditional_filters: {
      version: 1,
      rules: [{
        id: 'country-rule', source_field_id: 'country', source_field_type: null,
        operator: 'equals', value: 'GB', is_fallback: false,
        allowed_values: ['record-1'], org_filter: null,
      }],
    },
  };
  const saved = form(source, [{ id: 'target', prefill_field: 'org:name' }]);
  saved.fields.unshift(
    { id: 'country', type: 'select' },
    { id: 'group', type: 'organisation_group_dropdown' },
  );
  const seed = {
    form: [saved],
    organization: [{
      id: 'record-1', tenant_id: 'tenant-a', name: 'Eligible',
      organization_group_id: 'group-1',
    }],
    preference_field: [{
      id: 'status', tenant_id: 'tenant-a', name: 'application_status',
      entity_scope: 'organization', is_active: true,
    }],
    organization_preference_value: [{
      tenant_id: 'tenant-a', organization_id: 'record-1', field_id: 'status', value: 'approved',
    }],
  };
  assert.deepEqual((await resolve(seed, {
    sourceAnswers: { country: 'GB', group: 'group-1' },
  })).values, { target: 'Eligible' });
  await assert.rejects(resolve(seed, {
    sourceAnswers: { country: 'US', group: 'group-1' },
  }), error => error.code === 'PREFILL_RECORD_INELIGIBLE');
  await assert.rejects(resolve(seed, {
    sourceAnswers: { country: 'GB', group: 'group-2' },
  }), error => error.code === 'PREFILL_RECORD_INELIGIBLE');
  await assert.rejects(resolve(seed, {
    recordId: '__form_not_listed__',
  }), error => error.code === 'INVALID_PREFILL_RECORD');
});

test('selected records and custom values are tenant isolated', async () => {
  const saved = form(
    { id: 'source', type: 'organisation_group_dropdown' },
    [{ id: 'target', prefill_field: 'org_group:name' }],
  );
  await assert.rejects(resolve({
    form: [saved],
    organization_group: [{
      id: 'record-1', tenant_id: 'tenant-b', name: 'Foreign',
    }],
  }), error => error.code === 'PREFILL_RECORD_NOT_FOUND');
});

test('form schedule and access policy are enforced before record lookup', async () => {
  const saved = form(
    { id: 'source', type: 'organisation_group_dropdown' },
    [{ id: 'target', prefill_field: 'org_group:name' }],
    { deactivate_at: '2020-01-01T00:00:00.000Z' },
  );
  await assert.rejects(resolve({ form: [saved] }, {
    now: Date.parse('2021-01-01T00:00:00.000Z'),
  }), error => error.code === 'FORM_NOT_AVAILABLE');

  saved.deactivate_at = null;
  await assert.rejects(resolve({ form: [saved] }, {
    resolveAccess: async () => ({ allowed: false, code: 'FORM_ACCESS_DENIED' }),
  }), error => error.code === 'FORM_ACCESS_DENIED');
});

test('public route resolves the request tenant and passes only persisted form lookup inputs', async () => {
  const saved = form(
    { id: 'source', type: 'organisation_dropdown' },
    [{ id: 'target', type: 'text', prefill_field: 'org:name' }],
  );
  const req = {
    method: 'POST',
    body: {
      formId: 'form-1',
      sourceFieldId: 'source',
      recordId: 'record-1',
      sourceAnswers: {},
    },
  };
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await dropdownPrefillHandler(req, response, {
    db: fakeDb({
      form: [saved],
      organization: [{ id: 'record-1', tenant_id: 'tenant-a', name: 'Allowed' }],
    }),
    resolveTenant: async () => ({ id: 'tenant-a' }),
    resolveAccess: allowAccess,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { values: { target: 'Allowed' } });
});