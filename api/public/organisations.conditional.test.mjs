import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  filterOrganizationsEligibleForFields,
  isOrganizationEligibleForField,
  normalizeOrganizationPreferenceValue,
} from '../_lib/organizationEligibility.js';
import { loadConditionalOrganizationOptions, organizationsHandler } from './organisations.js';

const tenantId = 'tenant-1';

test('legacy scalar organisation preference normalization remains null-safe', () => {
  assert.equal(normalizeOrganizationPreferenceValue(null), null);
  assert.equal(normalizeOrganizationPreferenceValue(undefined), null);
});

function db(seed, stats = null) {
  class Query {
    constructor(table) {
      this.table = table; this.filters = []; this.sort = null;
      if (stats) stats[table] = (stats[table] || 0) + 1;
    }
    select() { return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
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

test('dynamic custom Country filter matches the earlier country answer across name and ISO storage', async () => {
  const form = savedForm([rule({
    operator: 'is_not_empty',
    value: null,
    org_filter: {
      type: 'custom',
      field: 'country',
      values: [],
      mode: 'include',
      value_source: 'source',
    },
  })]);
  form.fields[0].type = 'country';
  form.fields[1].org_filter = null;
  const database = db({
    form: [form],
    organization: [
      { id: 'name', tenant_id: tenantId, name: 'Stored as name' },
      { id: 'code', tenant_id: tenantId, name: 'Stored as code' },
      { id: 'other', tenant_id: tenantId, name: 'Other' },
    ],
    preference_field: [{
      id: 'country-field',
      tenant_id: tenantId,
      name: 'country',
      entity_scope: 'organization',
      field_type: 'country',
      is_active: true,
    }],
    organization_preference_value: [
      { organization_id: 'name', field_id: 'country-field', value: 'United Kingdom' },
      { organization_id: 'code', field_id: 'country-field', value: 'GB' },
      { organization_id: 'other', field_id: 'country-field', value: 'Spain' },
    ],
  });
  const result = await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: { country: 'United Kingdom' },
  });
  assert.deepEqual(result.map((organization) => organization.id), ['code', 'name']);
});

test('Country source matches names and ISO codes in a dropdown-backed organisation field', async () => {
  const form = savedForm([rule({
    operator: 'is_not_empty',
    value: null,
    org_filter: {
      type: 'custom',
      field: 'Overseas country',
      values: [],
      mode: 'include',
      value_source: 'source',
    },
  })]);
  form.id = '1b95a50e-2b5c-42f3-bf39-cc7fa69029d8';
  form.fields[0].type = 'country';
  form.fields[1].org_filter = null;
  const database = db({
    form: [form],
    organization: [
      { id: 'alzaiem', tenant_id: tenantId, name: 'Alzaiem Alazhari University' },
      { id: 'iso', tenant_id: tenantId, name: 'ISO stored organisation' },
      { id: 'multi', tenant_id: tenantId, name: 'Multi-value organisation' },
      { id: 'other', tenant_id: tenantId, name: 'Other organisation' },
    ],
    preference_field: [{
      id: 'overseas-country',
      tenant_id: tenantId,
      name: 'Overseas country',
      entity_scope: 'organization',
      field_type: 'dropdown',
      is_active: true,
    }],
    organization_preference_value: [
      { organization_id: 'alzaiem', field_id: 'overseas-country', value: 'Sudan' },
      { organization_id: 'iso', field_id: 'overseas-country', value: 'SD' },
      { organization_id: 'multi', field_id: 'overseas-country', value: JSON.stringify(['France', 'Sudan']) },
      { organization_id: 'other', field_id: 'overseas-country', value: 'Spain' },
    ],
  });
  const sourceAnswers = { country: 'Sudan' };
  const resolution = {
    org_filter: {
      type: 'custom',
      field: 'Overseas country',
      values: ['SD'],
      mode: 'include',
      value_source: 'source',
      comparison: 'country',
    },
  };

  const options = await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: form.id,
    fieldId: 'org',
    sourceAnswers,
  });
  assert.deepEqual(options.map((organization) => organization.id), ['alzaiem', 'iso', 'multi']);
  for (const organization of [
    { id: 'alzaiem', tenant_id: tenantId },
    { id: 'iso', tenant_id: tenantId },
    { id: 'multi', tenant_id: tenantId },
  ]) {
    assert.equal(await isOrganizationEligibleForField({
      db: database,
      tenantId,
      organization,
      field: resolution,
    }), true);
  }
  assert.equal(await isOrganizationEligibleForField({
    db: database,
    tenantId,
    organization: { id: 'other', tenant_id: tenantId },
    field: resolution,
  }), false);
});

test('Country source comparison also canonicalizes an organisation core country field', async () => {
  const organizations = [
    { id: 'name', country: 'Sudan' },
    { id: 'code', country: 'SD' },
    { id: 'other', country: 'Spain' },
  ];
  const filter = {
    org_filter: {
      type: 'core',
      field: 'country',
      values: ['SD'],
      value_source: 'source',
      comparison: 'country',
    },
  };
  assert.deepEqual((await filterOrganizationsEligibleForFields({
    db: db({}),
    tenantId,
    organizations,
    fields: [filter],
  })).map((organization) => organization.id), ['name', 'code']);
  assert.equal(await isOrganizationEligibleForField({
    db: db({}),
    tenantId,
    organization: organizations[0],
    field: filter,
  }), true);
});

test('fixed and non-country dropdown filters retain literal comparison behavior', async () => {
  const database = db({
    preference_field: [{
      id: 'country-dropdown',
      tenant_id: tenantId,
      name: 'country_dropdown',
      entity_scope: 'organization',
      field_type: 'dropdown',
      is_active: true,
    }],
    organization_preference_value: [
      { organization_id: 'name', field_id: 'country-dropdown', value: 'Sudan' },
      { organization_id: 'code', field_id: 'country-dropdown', value: 'SD' },
    ],
  });
  const organizations = [{ id: 'name' }, { id: 'code' }];
  for (const valueSource of ['fixed', 'source']) {
    const eligible = await filterOrganizationsEligibleForFields({
      db: database,
      tenantId,
      organizations,
      fields: [{
        org_filter: {
          type: 'custom',
          field: 'country_dropdown',
          values: ['SD'],
          value_source: valueSource,
        },
      }],
    });
    assert.deepEqual(eligible.map((organization) => organization.id), ['code']);
  }
});

test('multi-country organisation values match any saved country for options and submission validation', async () => {
  const database = db({
    preference_field: [{
      id: 'countries-field',
      tenant_id: tenantId,
      name: 'operating_countries',
      entity_scope: 'organization',
      field_type: 'countries',
      is_active: true,
    }],
    organization_preference_value: [{
      organization_id: 'multi',
      field_id: 'countries-field',
      value: JSON.stringify(['France', 'United Kingdom']),
    }],
  });
  const organization = { id: 'multi', tenant_id: tenantId, name: 'Multi-country' };
  const field = {
    org_filter: {
      type: 'custom',
      field: 'operating_countries',
      values: ['GB'],
      mode: 'include',
      value_source: 'source',
    },
  };
  assert.deepEqual((await filterOrganizationsEligibleForFields({
    db: database,
    tenantId,
    organizations: [organization],
    fields: [field],
  })).map((item) => item.id), ['multi']);
  assert.equal(await isOrganizationEligibleForField({
    db: database,
    tenantId,
    organization,
    field,
  }), true);
});

test('dynamic organisation options exclude target IDs and country values without broadening eligibility', async () => {
  const form = savedForm([rule({
    allowed_values: ['blocked-id'],
    allowed_values_mode: 'exclude',
    org_filter: {
      type: 'core',
      field: 'country',
      values: ['Spain'],
      mode: 'exclude',
    },
  })]);
  form.fields[1].org_filter = null;
  const result = await loadConditionalOrganizationOptions({
    db: db({
      form: [form],
      organization: [
        { id: 'blocked-id', tenant_id: tenantId, name: 'Blocked ID', country: 'France' },
        { id: 'blocked-country', tenant_id: tenantId, name: 'Blocked country', country: 'Spain' },
        { id: 'new-id', tenant_id: tenantId, name: 'Newly added', country: 'Portugal' },
      ],
    }),
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: { country: 'GB' },
  });
  assert.deepEqual(result.map((org) => org.id), ['new-id']);
});

test('saved organisation filters fail closed for invalid empty modes but allow valid empty exclusions', async () => {
  const base = savedForm([]);
  base.fields[1].conditional_filters = undefined;
  base.fields[1].org_filter = {
    type: 'core',
    field: 'country',
    values: [],
    mode: 'forged',
  };
  const seed = {
    organization: [
      { id: 'one', tenant_id: tenantId, name: 'One', country: 'Portugal' },
    ],
  };
  assert.deepEqual(await loadConditionalOrganizationOptions({
    db: db({ ...seed, form: [base] }),
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: {},
  }), []);

  base.fields[1].org_filter.mode = 'exclude';
  assert.deepEqual((await loadConditionalOrganizationOptions({
    db: db({ ...seed, form: [base] }),
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: {},
  })).map((org) => org.id), ['one']);

  base.fields[1].org_filter.mode = 'include';
  assert.deepEqual((await loadConditionalOrganizationOptions({
    db: db({ ...seed, form: [base] }),
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: {},
  })).map((org) => org.id), ['one']);
});

test('populated core and custom filters exclude records with empty values in both modes', async () => {
  const organizations = [
    { id: 'match', status: 'approved' },
    { id: 'other', status: 'pending' },
    { id: 'missing' },
    { id: 'blank', status: '   ' },
  ];
  for (const mode of ['include', 'exclude']) {
    const core = await filterOrganizationsEligibleForFields({
      db: db({}),
      tenantId,
      organizations,
      fields: [{ org_filter: { type: 'core', field: 'status', values: ['approved'], mode } }],
    });
    assert.deepEqual(core.map(item => item.id), mode === 'include' ? ['match'] : ['other']);
  }

  const customSeed = {
    preference_field: [{
      id: 'sector-field', tenant_id: tenantId, name: 'sector',
      entity_scope: 'organization', is_active: true,
    }],
    organization_preference_value: [
      { organization_id: 'match', field_id: 'sector-field', value: 'arts' },
      { organization_id: 'other', field_id: 'sector-field', value: 'tech' },
      { organization_id: 'blank', field_id: 'sector-field', value: '   ' },
    ],
  };
  for (const mode of ['include', 'exclude']) {
    const custom = await filterOrganizationsEligibleForFields({
      db: db(customSeed),
      tenantId,
      organizations,
      fields: [{ org_filter: { type: 'custom', field: 'sector', values: ['arts'], mode } }],
    });
    assert.deepEqual(custom.map(item => item.id), mode === 'include' ? ['match'] : ['other']);
  }
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

test('GET handler preserves legacy allowedStatuses filtering', async () => {
  const request = {
    method: 'GET',
    query: { allowedStatuses: JSON.stringify(['approved']) },
  };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await organizationsHandler(request, response, {
    db: db({
      organization: [
        { id: 'approved', tenant_id: tenantId, name: 'Approved' },
        { id: 'pending', tenant_id: tenantId, name: 'Pending' },
      ],
      preference_field: [{
        id: 'status-field',
        tenant_id: tenantId,
        name: 'application_status',
        entity_scope: 'organization',
        is_active: true,
      }],
      organization_preference_value: [
        { organization_id: 'approved', field_id: 'status-field', value: 'approved' },
        { organization_id: 'pending', field_id: 'status-field', value: 'pending' },
      ],
    }),
    resolveTenant: async () => ({ id: tenantId }),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.map((org) => org.id), ['approved']);
});

test('directory GET combines saved organisation type and application status filters', async () => {
  const request = {
    method: 'GET',
    query: {
      directory: 'true',
      allowedStatuses: JSON.stringify(['approved']),
    },
  };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await organizationsHandler(request, response, {
    db: db({
      system_settings: [
        {
          tenant_id: tenantId,
          setting_key: 'org_directory_visible_org_types',
          setting_value: JSON.stringify(['University']),
        },
        {
          tenant_id: 'tenant-2',
          setting_key: 'org_directory_visible_org_types',
          setting_value: JSON.stringify(['Partner']),
        },
      ],
      organization: [
        { id: 'university', tenant_id: tenantId, name: 'University' },
        { id: 'university-pending', tenant_id: tenantId, name: 'Pending University' },
        { id: 'partner', tenant_id: tenantId, name: 'Partner' },
        { id: 'other-tenant', tenant_id: 'tenant-2', name: 'Other tenant university' },
      ],
      preference_field: [
        {
          id: 'status-field',
          tenant_id: tenantId,
          name: 'application_status',
          entity_scope: 'organization',
          field_type: 'select',
          is_active: true,
        },
        {
          id: 'type-field',
          tenant_id: tenantId,
          name: 'org_type',
          entity_scope: 'organization',
          field_type: 'select',
          is_active: true,
        },
      ],
      organization_preference_value: [
        { organization_id: 'university', field_id: 'status-field', value: 'approved' },
        { organization_id: 'university', field_id: 'type-field', value: 'University' },
        { organization_id: 'university-pending', field_id: 'status-field', value: 'pending' },
        { organization_id: 'university-pending', field_id: 'type-field', value: 'University' },
        { organization_id: 'partner', field_id: 'status-field', value: 'approved' },
        { organization_id: 'partner', field_id: 'type-field', value: 'Partner' },
      ],
    }),
    resolveTenant: async () => ({ id: tenantId }),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.map((organization) => organization.id), ['university']);
});

test('directory GET supports organisation type field aliases', async () => {
  for (const fieldName of ['organisation_type', 'organization_type']) {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    await organizationsHandler(
      { method: 'GET', query: { directory: '1' } },
      response,
      {
        db: db({
          system_settings: [{
            tenant_id: tenantId,
            setting_key: 'org_directory_visible_org_types',
            setting_value: '["University"]',
          }],
          organization: [
            { id: 'university', tenant_id: tenantId, name: 'University' },
            { id: 'partner', tenant_id: tenantId, name: 'Partner' },
          ],
          preference_field: [{
            id: 'type-field',
            tenant_id: tenantId,
            name: fieldName,
            entity_scope: 'organization',
            field_type: 'select',
            is_active: true,
          }],
          organization_preference_value: [
            { organization_id: 'university', field_id: 'type-field', value: 'University' },
            { organization_id: 'partner', field_id: 'type-field', value: 'Partner' },
          ],
        }),
        resolveTenant: async () => ({ id: tenantId }),
      },
    );
    assert.deepEqual(response.payload.map((organization) => organization.id), ['university']);
  }
});

test('directory GET preserves all types when the saved type setting is absent or empty', async () => {
  for (const systemSettings of [
    [],
    [{
      tenant_id: tenantId,
      setting_key: 'org_directory_visible_org_types',
      setting_value: '[]',
    }],
  ]) {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    await organizationsHandler(
      { method: 'GET', query: { directory: 'true' } },
      response,
      {
        db: db({
          system_settings: systemSettings,
          organization: [
            { id: 'university', tenant_id: tenantId, name: 'University' },
            { id: 'partner', tenant_id: tenantId, name: 'Partner' },
          ],
        }),
        resolveTenant: async () => ({ id: tenantId }),
      },
    );
    assert.deepEqual(
      response.payload.map((organization) => organization.id),
      ['partner', 'university'],
    );
  }
});

test('iEdit directory delegates type eligibility to the public endpoint', () => {
  const rendererSource = fs.readFileSync(
    new URL('../../client/src/components/iedit/elements/IEditOrganisationDirectoryElement.jsx', import.meta.url),
    'utf8',
  );
  const publicClientSource = fs.readFileSync(
    new URL('../../client/src/api/publicClient.js', import.meta.url),
    'utf8',
  );
  assert.match(rendererSource, /const options = \{ directoryPolicy: true \}/);
  assert.doesNotMatch(rendererSource, /OrganizationPreferenceValue\.list/);
  assert.match(publicClientSource, /options\.directoryPolicy[\s\S]*params\.set\('directory', 'true'\)/);
});

test('nested organisation options resolve only a persisted child of the requested repeatable container', async () => {
  const nested = {
    id: 'form-rows', tenant_id: tenantId, slug: 'rows', is_active: true,
    fields: [{
      id: 'employment', type: 'repeatable_rows',
      child_fields: [
        { id: 'country', type: 'select' },
        {
          id: 'org', type: 'organisation_dropdown',
          conditional_filters: { version: 1, rules: [rule()] },
        },
      ],
    }, {
      // Same child ID outside the container must never be selected.
      id: 'org', type: 'organisation_dropdown',
      conditional_filters: { version: 1, rules: [] },
    }],
  };
  const database = db({
    form: [nested],
    organization: [
      { id: 'approved', tenant_id: tenantId, name: 'Approved', status: 'approved' },
      { id: 'pending', tenant_id: tenantId, name: 'Pending', status: 'pending' },
    ],
  });
  const result = await loadConditionalOrganizationOptions({
    db: database, tenantId, formSlug: 'rows', containerFieldId: 'employment',
    fieldId: 'org', sourceAnswers: { country: 'GB' },
  });
  assert.deepEqual(result.map((item) => item.id), ['approved']);
  assert.deepEqual(await loadConditionalOrganizationOptions({
    db: database, tenantId, formSlug: 'rows', containerFieldId: 'forged',
    fieldId: 'org', sourceAnswers: { country: 'GB' },
  }), []);
  assert.deepEqual(await loadConditionalOrganizationOptions({
    db: database, tenantId, formSlug: 'rows', containerFieldId: 'employment',
    fieldId: 'not-a-child', sourceAnswers: { country: 'GB' },
  }), []);
});

test('organisation options are restricted by a saved Organisation Group parent and existing filters', async () => {
  const form = savedForm([rule()]);
  form.fields[0] = { id: 'group', type: 'organisation_group_dropdown' };
  form.fields[1].organisation_group_parent_field_id = 'group';
  const database = db({
    form: [form],
    organization_group: [
      { id: 'group-1', tenant_id: tenantId, name: 'One' },
      { id: 'other-tenant-group', tenant_id: 'tenant-2', name: 'Other' },
    ],
    organization: [
      { id: 'match', tenant_id: tenantId, organization_group_id: 'group-1', name: 'Match', is_active: true, status: 'approved' },
      { id: 'wrong-group', tenant_id: tenantId, organization_group_id: 'group-2', name: 'Wrong group', is_active: true, status: 'approved' },
      { id: 'wrong-filter', tenant_id: tenantId, organization_group_id: 'group-1', name: 'Wrong filter', is_active: true, status: 'pending' },
    ],
  });
  assert.deepEqual((await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: { group: 'group-1', country: 'GB' },
  })).map(item => item.id), ['match']);
  assert.deepEqual(await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: { group: '', country: 'GB' },
  }), []);
  assert.deepEqual(await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: { group: '__form_not_listed__', country: 'GB' },
  }), []);
  assert.deepEqual(await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: { group: 'other-tenant-group', country: 'GB' },
  }), []);
});

test('repeatable organisation group filtering uses only the same row answers', async () => {
  const nested = {
    id: 'form-rows', tenant_id: tenantId, slug: 'rows', is_active: true,
    fields: [{
      id: 'employment', type: 'repeatable_rows',
      child_fields: [
        { id: 'group', type: 'organisation_group_dropdown' },
        {
          id: 'org', type: 'organisation_dropdown',
          organisation_group_parent_field_id: 'group',
        },
      ],
    }],
  };
  const database = db({
    form: [nested],
    organization_group: [{ id: 'group-1', tenant_id: tenantId, name: 'One' }],
    organization: [
      { id: 'one', tenant_id: tenantId, organization_group_id: 'group-1', name: 'One' },
      { id: 'two', tenant_id: tenantId, organization_group_id: 'group-2', name: 'Two' },
    ],
  });
  const result = await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: 'form-rows',
    containerFieldId: 'employment',
    fieldId: 'org',
    sourceAnswers: { group: 'group-1' },
  });
  assert.deepEqual(result.map(item => item.id), ['one']);
});

test('repeatable organisations can share a preceding form-scoped Organisation Group', async () => {
  const nested = {
    id: 'form-shared-group', tenant_id: tenantId, slug: 'shared-group', is_active: true,
    fields: [{
      id: 'group', type: 'organisation_group_dropdown',
    }, {
      id: 'employment', type: 'repeatable_rows',
      child_fields: [{
        id: 'org',
        type: 'organisation_dropdown',
        organisation_group_parent_field_id: 'group',
        organisation_group_parent_scope: 'form',
      }],
    }],
  };
  const database = db({
    form: [nested],
    organization_group: [{ id: 'group-1', tenant_id: tenantId, name: 'One' }],
    organization: [
      { id: 'one', tenant_id: tenantId, organization_group_id: 'group-1', name: 'One' },
      { id: 'two', tenant_id: tenantId, organization_group_id: 'group-2', name: 'Two' },
    ],
  });
  const result = await loadConditionalOrganizationOptions({
    db: database, tenantId, formId: 'form-shared-group',
    containerFieldId: 'employment', fieldId: 'org',
    sourceAnswers: { group: 'group-1' },
  });
  assert.deepEqual(result.map(item => item.id), ['one']);
});

test('custom filters use bounded chunked reads instead of querying once per organisation', async () => {
  const stats = {};
  const organizations = Array.from({ length: 501 }, (_, index) => ({
    id: `org-${index}`,
    tenant_id: tenantId,
    name: `Organisation ${index}`,
  }));
  const customForm = savedForm([rule({
    org_filter: { type: 'custom', field: 'country', values: ['Wales'] },
  })]);
  customForm.fields[1].org_filter = {
    type: 'custom',
    field: 'application_status',
    values: ['approved'],
  };
  const database = db({
    form: [customForm],
    organization: organizations,
    preference_field: [
      {
        id: 'status-field', tenant_id: tenantId, name: 'application_status',
        entity_scope: 'organization', is_active: true,
      },
      {
        id: 'country-field', tenant_id: tenantId, name: 'country',
        entity_scope: 'organization', is_active: true,
      },
    ],
    organization_preference_value: organizations.flatMap((organization, index) => [
      { organization_id: organization.id, field_id: 'status-field', value: 'approved' },
      { organization_id: organization.id, field_id: 'country-field', value: index === 0 ? 'Wales' : 'England' },
    ]),
  }, stats);

  const result = await loadConditionalOrganizationOptions({
    db: database,
    tenantId,
    formId: 'form-1',
    fieldId: 'org',
    sourceAnswers: { country: 'GB' },
  });

  assert.deepEqual(result.map((organization) => organization.id), ['org-0']);
  assert.equal(stats.preference_field, 2);
  assert.equal(stats.organization_preference_value, 4);
});
