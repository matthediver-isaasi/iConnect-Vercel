import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadFormOrganisationGroupOptions,
  resolveMemberOrganisationGroupId,
  resolveTenantOrganisationGroupId,
  validateFormOrganisationGroupAnswers,
  validateOrganisationGroupDependentOrganizationAnswers,
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

test('form-aware group options resolve only a saved repeatable child', async () => {
  const db = fakeDb({
    forms: [{
      id: 'form-a',
      slug: 'safe',
      tenant_id: 'tenant-a',
      is_active: true,
      fields: [{
        id: 'rows',
        type: 'repeatable_rows',
        child_fields: [{ id: 'group', type: 'organisation_group_dropdown' }],
      }],
    }],
    groups: [{ id: 'a-1', tenant_id: 'tenant-a', name: 'Alpha' }],
  });
  assert.deepEqual(await loadFormOrganisationGroupOptions({
    db,
    tenantId: 'tenant-a',
    formSlug: 'safe',
    containerFieldId: 'rows',
    fieldId: 'group',
  }), [{ id: 'a-1', tenant_id: 'tenant-a', name: 'Alpha' }]);
  assert.deepEqual(await loadFormOrganisationGroupOptions({
    db,
    tenantId: 'tenant-a',
    formSlug: 'safe',
    containerFieldId: 'forged',
    fieldId: 'group',
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

test('hidden organisation group selections are ignored while visible forged selections still fail', async () => {
  const db = fakeDb({
    groups: [{ id: 'safe-group', tenant_id: 'tenant-a', name: 'Safe' }],
  });
  const fields = [{ id: 'group', type: 'organisation_group_dropdown' }];
  await assert.doesNotReject(validateFormOrganisationGroupAnswers({
    db,
    tenantId: 'tenant-a',
    fields,
    submissionData: { group: 'stale-forged-group' },
    hiddenFieldIds: new Set(['group']),
  }));
  await assert.rejects(validateFormOrganisationGroupAnswers({
    db,
    tenantId: 'tenant-a',
    fields,
    submissionData: { group: 'stale-forged-group' },
    hiddenFieldIds: new Set(),
  }), error => error.code === 'INVALID_ORGANISATION_GROUP');
});

test('submission validation accepts the configured not-listed group sentinel', async () => {
  const db = fakeDb({
    groups: [{ id: 'safe-group', tenant_id: 'tenant-a', name: 'Safe' }],
  });
  await assert.doesNotReject(validateFormOrganisationGroupAnswers({
    db,
    tenantId: 'tenant-a',
    fields: [{
      id: 'group',
      type: 'organisation_group_dropdown',
      not_listed_choice: { enabled: true, label: 'My group is not listed' },
    }],
    submissionData: { group: '__form_not_listed__' },
  }));
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

test('dependent organisation answers must belong to the selected tenant group', async () => {
  const fields = [
    { id: 'group', type: 'organisation_group_dropdown' },
    { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
  ];
  await assert.doesNotReject(validateOrganisationGroupDependentOrganizationAnswers({
    db: fakeDb({
      organizations: [{ id: 'org-1', tenant_id: 'tenant-a', organization_group_id: 'group-1' }],
    }),
    tenantId: 'tenant-a',
    fields,
    submissionData: { group: 'group-1', org: 'org-1' },
  }));
  await assert.rejects(validateOrganisationGroupDependentOrganizationAnswers({
    db: fakeDb({
      organizations: [{ id: 'org-2', tenant_id: 'tenant-a', organization_group_id: 'group-2' }],
    }),
    tenantId: 'tenant-a',
    fields,
    submissionData: { group: 'group-1', org: 'org-2' },
  }), error => error.code === 'INVALID_ORGANISATION_GROUP_ORGANISATION');
});

test('a not-listed group can carry a not-listed dependent organisation', async () => {
  const fields = [
    {
      id: 'group',
      type: 'organisation_group_dropdown',
      not_listed_choice: { enabled: true, label: 'My group is not listed' },
    },
    {
      id: 'org',
      type: 'organisation_dropdown',
      organisation_group_parent_field_id: 'group',
      not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
    },
  ];
  await assert.doesNotReject(validateOrganisationGroupDependentOrganizationAnswers({
    db: fakeDb({}),
    tenantId: 'tenant-a',
    fields,
    submissionData: {
      group: '__form_not_listed__',
      org: '__form_not_listed__',
    },
  }));
});

test('dependent organisation validation stays inside each repeatable row', async () => {
  const fields = [{
    id: 'rows',
    type: 'repeatable_rows',
    child_fields: [
      { id: 'group', type: 'organisation_group_dropdown' },
      { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
    ],
  }];
  const database = fakeDb({
    organizations: [
      { id: 'org-1', tenant_id: 'tenant-a', organization_group_id: 'group-1' },
      { id: 'org-2', tenant_id: 'tenant-a', organization_group_id: 'group-2' },
    ],
  });
  await assert.doesNotReject(validateOrganisationGroupDependentOrganizationAnswers({
    db: database,
    tenantId: 'tenant-a',
    fields,
    submissionData: { rows: [
      { group: 'group-1', org: 'org-1' },
      { group: 'group-2', org: 'org-2' },
    ] },
  }));
  await assert.rejects(validateOrganisationGroupDependentOrganizationAnswers({
    db: database,
    tenantId: 'tenant-a',
    fields,
    submissionData: { rows: [{ group: 'group-1', org: 'org-2' }] },
  }), error => error.code === 'INVALID_ORGANISATION_GROUP_ORGANISATION');
});

test('hidden repeatable containers are not re-entered by group validators', async () => {
  const fields = [{
    id: 'rows',
    type: 'repeatable_rows',
    child_fields: [
      { id: 'group', type: 'organisation_group_dropdown' },
      { id: 'org', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group' },
    ],
  }];
  const input = {
    db: fakeDb({}),
    tenantId: 'tenant-a',
    fields,
    submissionData: { rows: [{ group: 'forged-group', org: 'forged-org' }] },
    hiddenFieldIds: new Set(['rows']),
  };
  await assert.doesNotReject(validateFormOrganisationGroupAnswers(input));
  await assert.doesNotReject(validateOrganisationGroupDependentOrganizationAnswers(input));
});

test('repeatable Organisation Group values are tenant validated even without an organisation answer', async () => {
  const fields = [{
    id: 'rows',
    type: 'repeatable_rows',
    child_fields: [{ id: 'group', type: 'organisation_group_dropdown' }],
  }];
  await assert.rejects(validateFormOrganisationGroupAnswers({
    db: fakeDb({
      groups: [{ id: 'foreign', tenant_id: 'tenant-b', name: 'Foreign' }],
    }),
    tenantId: 'tenant-a',
    fields,
    submissionData: { rows: [{ group: 'foreign' }] },
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