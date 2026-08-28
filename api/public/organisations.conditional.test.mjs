import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConditionalOrganizationOptions, organizationsHandler } from './organisations.js';

const tenantId = 'tenant-1';

function db(seed) {
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.sort = null; }
    select() { return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    order(column) { this.sort = column; return this; }
    async maybeSingle() {
      const result = this.rows();
      return { data: result[0] || null, error: null };
    }
    then(resolve) { return Promise.resolve({ data: this.rows(), error: null }).then(resolve); }
    rows() {
      const rows = structuredClone(seed[this.table] || []).filter((row) => this.filters.every((filter) => filter(row)));
      if (this.sort) rows.sort((a, b) => String(a[this.sort] || '').localeCompare(String(b[this.sort] || '')));
      return rows;
    }
  }
  return { from: (table) => new Query(table) };
}

function savedForm(rules) {
  return {
    id: 'form-1', tenant_id: tenantId, slug: 'apply', is_active: true,
    fields: [
      { id: 'country', name: 'country', type: 'dropdown' },
      {
        id: 'org', type: 'organisation_dropdown',
        options: [],
        org_filter: { type: 'core', field: 'is_active', values: ['true'] },
        conditional_filters: { version: 1, rules },
      },
    ],
  };
}

const rule = (extra = {}) => ({
  id: 'gb', source_field_id: 'country', operator: 'equals', value: 'GB',
  is_fallback: false, allowed_values: [], org_filter: { type: 'core', field: 'status', values: ['approved'] },
  ...extra,
});

test('dynamic organisation options use saved form rules, static restrictions, and trusted answers', async () => {
  const result = await loadConditionalOrganizationOptions({
    db: db({
      form: [savedForm([rule({ allowed_values: ['approved'] })])],
      organization: [
        { id: 'approved', tenant_id: tenantId, name: 'Approved', is_active: true, status: 'approved' },
        { id: 'wrong-status', tenant_id: tenantId, name: 'Wrong', is_active: true, status: 'pending' },
        { id: 'inactive', tenant_id: tenantId, name: 'Inactive', is_active: false, status: 'approved' },
      ],
    }),
    tenantId, formSlug: 'apply', fieldId: 'org', sourceAnswers: { country: { value: 'GB' } },
  });
  assert.deepEqual(result.map((org) => org.id), ['approved']);
});

test('empty matched allowed_values adds no ID restriction while org filter still applies', async () => {
  const result = await loadConditionalOrganizationOptions({
    db: db({
      form: [savedForm([rule()])],
      organization: [
        { id: 'one', tenant_id: tenantId, name: 'One', is_active: true, status: 'approved' },
        { id: 'two', tenant_id: tenantId, name: 'Two', is_active: true, status: 'approved' },
      ],
    }),
    tenantId, formId: 'form-1', fieldId: 'org', sourceAnswers: { country: 'GB' },
  });
  assert.deepEqual(result.map((org) => org.id), ['one', 'two']);
});

test('unmatched, malformed, and forged field requests fail closed', async () => {
  const common = {
    tenantId, formId: 'form-1', fieldId: 'org', sourceAnswers: { country: 'US' },
    db: db({
      form: [savedForm([rule()])],
      organization: [{ id: 'one', tenant_id: tenantId, name: 'One', is_active: true, status: 'approved' }],
    }),
  };
  assert.deepEqual(await loadConditionalOrganizationOptions(common), []);
  assert.deepEqual(await loadConditionalOrganizationOptions({ ...common, fieldId: 'forged' }), []);
  assert.deepEqual(await loadConditionalOrganizationOptions({
    ...common,
    sourceAnswers: { country: 'GB' },
    db: db({
      form: [savedForm([{ ...rule(), operator: 'forged' }])],
      organization: [{ id: 'one', tenant_id: tenantId, name: 'One', is_active: true, status: 'approved' }],
    }),
  }), []);
});

test('empty rules retain static-only legacy behavior in dynamic mode', async () => {
  const result = await loadConditionalOrganizationOptions({
    db: db({
      form: [savedForm([])],
      organization: [
        { id: 'yes', tenant_id: tenantId, name: 'Yes', is_active: true, status: 'pending' },
        { id: 'no', tenant_id: tenantId, name: 'No', is_active: false, status: 'approved' },
      ],
    }),
    tenantId, formId: 'form-1', fieldId: 'org', sourceAnswers: {},
  });
  assert.deepEqual(result.map((org) => org.id), ['yes']);
});

test('POST handler accepts dynamic answers in JSON body and resolves tenant normally', async () => {
  const database = db({
    form: [savedForm([rule()])],
    organization: [
      { id: 'yes', tenant_id: tenantId, name: 'Yes', is_active: true, status: 'approved' },
      { id: 'no', tenant_id: tenantId, name: 'No', is_active: true, status: 'pending' },
    ],
  });
  const req = {
    method: 'POST',
    query: {},
    body: {
      formSlug: 'apply',
      fieldId: 'org',
      sourceAnswers: { country: 'GB' },
    },
  };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await organizationsHandler(req, response, {
    db: database,
    resolveTenant: async () => ({ id: tenantId }),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.map((org) => org.id), ['yes']);
});

test('POST handler accepts targetFieldId as a compatibility alias', async () => {
  const request = {
    method: 'POST',
    query: {},
    body: {
      formId: 'form-1',
      targetFieldId: 'org',
      sourceAnswers: { country: 'GB' },
    },
  };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await organizationsHandler(request, response, {
    db: db({
      form: [savedForm([rule()])],
      organization: [
        { id: 'yes', tenant_id: tenantId, name: 'Yes', is_active: true, status: 'approved' },
      ],
    }),
    resolveTenant: async () => ({ id: tenantId }),
  });
  assert.deepEqual(response.payload.map((org) => org.id), ['yes']);
});