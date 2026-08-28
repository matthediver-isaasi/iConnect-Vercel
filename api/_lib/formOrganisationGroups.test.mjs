import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadFormOrganisationGroupOptions,
  resolveMemberOrganisationGroupId,
  resolveTenantOrganisationGroupId,
  validateFormOrganisationGroupAnswers,
} from './formOrganisationGroups.js';

function fakeDb({ forms = [], groups = [], organizations = [] } = {}) {
  return {
    from(table) {
      const filters = [];
      let ids = null;
      const rowsForTable = table === 'form'
        ? forms
        : (table === 'organization' ? organizations : groups);
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        in(_column, values) { ids = values.map(String); return query; },
        order() {
          const rows = rowsForTable
            .filter(row => filters.every(([column, value]) => row[column] === value))
            .filter(row => !ids || ids.includes(String(row.id)))
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
          return Promise.resolve({ data: rows, error: null });
        },
        maybeSingle() {
          const row = rowsForTable.find(candidate =>
            filters.every(([column, value]) => candidate[column] === value));
          return Promise.resolve({ data: row || null, error: null });
        },
      };
      return query;
    },
  };
}

test('form-aware group options are tenant scoped and ordered', async () => {
  const db = fakeDb({
    forms: [
      { id: 'form-a', slug: 'safe', tenant_id: 'tenant-a', is_active: true, fields: [{ id: 'group', type: 'organisation_group_dropdown' }] },
      { id: 'form-b', slug: 'safe', tenant_id: 'tenant-b', is_active: true, fields: [{ id: 'group', type: 'organisation_group_dropdown' }] },
    ],
    groups: [
      { id: 'a-2', tenant_id: 'tenant-a', name: 'Zulu' },
      { id: 'b-1', tenant_id: 'tenant-b', name: 'Leaked' },
      { id: 'a-1', tenant_id: 'tenant-a', name: 'Alpha' },
    ],
  });
  assert.deepEqual(await loadFormOrganisationGroupOptions({
    db, tenantId: 'tenant-a', formSlug: 'safe', fieldId: 'group',
  }), [
    { id: 'a-1', tenant_id: 'tenant-a', name: 'Alpha' },
    { id: 'a-2', tenant_id: 'tenant-a', name: 'Zulu' },
  ]);
  assert.deepEqual(await loadFormOrganisationGroupOptions({
    db, tenantId: 'tenant-a', formSlug: 'safe', fieldId: 'wrong',
  }), []);
});

test('submission validation accepts current-tenant IDs and rejects forged IDs', async () => {
  const db = fakeDb({
    groups: [
      { id: 'safe-group', tenant_id: 'tenant-a', name: 'Safe' },
      { id: 'foreign-group', tenant_id: 'tenant-b', name: 'Foreign' },
    ],
  });
  const fields = [{ id: 'group', type: 'organisation_group_dropdown' }];
  await assert.doesNotReject(validateFormOrganisationGroupAnswers({
    db, tenantId: 'tenant-a', fields, submissionData: { group: 'safe-group' },
  }));
  await assert.rejects(validateFormOrganisationGroupAnswers({
    db, tenantId: 'tenant-a', fields, submissionData: { group: 'foreign-group' },
  }), error => error.code === 'INVALID_ORGANISATION_GROUP');
});

test('submission validation rejects a tenant group excluded by the matched conditional rule', async () => {
  const db = fakeDb({
    groups: [
      { id: 'north', tenant_id: 'tenant-a', name: 'North' },
      { id: 'south', tenant_id: 'tenant-a', name: 'South' },
    ],
  });
  const fields = [
    { id: 'region', type: 'select', options: ['Northern', 'Southern'] },
    {
      id: 'group',
      type: 'organisation_group_dropdown',
      conditional_filters: {
        version: 1,
        rules: [{
          id: 'north-rule',
          source_field_id: 'region',
          source_field_type: null,
          operator: 'equals',
          value: 'Northern',
          is_fallback: false,
          allowed_values: ['north'],
          org_filter: null,
        }],
      },
    },
  ];
  await assert.doesNotReject(validateFormOrganisationGroupAnswers({
    db,
    tenantId: 'tenant-a',
    fields,
    submissionData: { region: 'Northern', group: 'north' },
  }));
  await assert.rejects(validateFormOrganisationGroupAnswers({
    db,
    tenantId: 'tenant-a',
    fields,
    submissionData: { region: 'Northern', group: 'south' },
  }), error => error.code === 'INVALID_ORGANISATION_GROUP');
  await assert.rejects(validateFormOrganisationGroupAnswers({
    db,
    tenantId: 'tenant-a',
    fields,
    submissionData: { region: 'Southern', group: 'north' },
  }), error => error.code === 'INVALID_ORGANISATION_GROUP');
});

test('organisation prefill keeps only a current-tenant parent group', async () => {
  const db = fakeDb({
    groups: [
      { id: 'safe-group', tenant_id: 'tenant-a', name: 'Safe' },
      { id: 'foreign-group', tenant_id: 'tenant-b', name: 'Foreign' },
    ],
  });
  assert.equal(await resolveTenantOrganisationGroupId({
    db, tenantId: 'tenant-a', groupId: 'safe-group',
  }), 'safe-group');
  assert.equal(await resolveTenantOrganisationGroupId({
    db, tenantId: 'tenant-a', groupId: 'foreign-group',
  }), null);
  assert.equal(await resolveTenantOrganisationGroupId({
    db, tenantId: 'tenant-a', groupId: null,
  }), null);
});

test('anonymous member prefill inherits the tenant-scoped group from its linked organisation', async () => {
  const db = fakeDb({
    organizations: [
      { id: 'org-a', tenant_id: 'tenant-a', organization_group_id: 'safe-group' },
      { id: 'org-b', tenant_id: 'tenant-b', organization_group_id: 'foreign-group' },
    ],
    groups: [
      { id: 'safe-group', tenant_id: 'tenant-a', name: 'Safe' },
      { id: 'foreign-group', tenant_id: 'tenant-b', name: 'Foreign' },
    ],
  });
  assert.equal(await resolveMemberOrganisationGroupId({
    db,
    tenantId: 'tenant-a',
    member: { organization_id: 'org-a' },
  }), 'safe-group');
  assert.equal(await resolveMemberOrganisationGroupId({
    db,
    tenantId: 'tenant-a',
    member: { organization_id: 'org-b' },
  }), null);
});

test('public organisation prefill scopes the organisation query to the tenant', () => {
  const source = readFileSync(new URL('../public/organisation/[id].js', import.meta.url), 'utf8');
  assert.match(
    source,
    /\.from\('organization'\)[\s\S]*?\.eq\('id', id\)[\s\S]*?\.eq\('tenant_id', tenantId\)[\s\S]*?\.single\(\)/,
  );
  assert.match(source, /if \(org\.tenant_id !== tenantId\)/);
});