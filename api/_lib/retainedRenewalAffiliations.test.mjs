import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRetainedRenewalAffiliations, retainsOrganization } from './retainedRenewalAffiliations.js';
import { isOrganizationEligibleForField } from './organizationEligibility.js';
import { validateOrganisationGroupDependentOrganizationAnswers } from './formOrganisationGroups.js';
import { createFormRelationshipService } from './formRelationshipOptions.js';
import { loadConditionalOrganizationOptions } from '../public/organisations.js';
import { computeAuthoritativeHiddenFieldIds } from './formFieldVisibility.js';

function fixture() {
  const form = { id: 'form', slug: 'renewal', tenant_id: 'tenant', is_active: true,
    member_affiliation_enabled: true, require_authentication: true,
    mutation_access_policy: { mode: 'authenticated_owner' }, fields: [
      { id: 'group', type: 'organisation_group_dropdown' },
      { id: 'primary', type: 'organisation_dropdown', organisation_group_parent_field_id: 'group',
        org_filter: { type: 'custom', field: 'type', values: ['Hospital'] } },
      { id: 'department', type: 'relationship_dropdown', selection_mode: 'multiple', parent_field_id: 'primary',
        relationship_definition_id: 'department-org', custom_object_id: 'departments',
        custom_object_primary_display_field_id: 'department-name' },
      { id: 'sites', type: 'repeatable_rows', version: 1, hide_when_first_column_empty: true,
        child_fields: [{ id: 'secondary', type: 'organisation_dropdown',
          exclude_values_from: { scope: 'form', source_field_id: 'primary' },
          organisation_group_parent_field_id: 'group', organisation_group_parent_scope: 'form' }] },
    ] };
  const tables = {
    form: [form],
    form_member_affiliation_config: [{ tenant_id: 'tenant', form_id: 'form', config: {
      enabled: true, primaryOrganizationFieldIds: ['primary'], additionalSitesFieldId: 'sites',
      secondaryOrganizationFieldId: 'secondary', secondaryMemberDefinitionId: 'member-assignment',
      secondaryObjectId: 'assignments',
      secondaryOrganizationDefinitionId: 'assignment-org',
    } }],
    member: [{ id: 'member', tenant_id: 'tenant', organization_id: 'primary-org' }],
    organization_group: [{ id: 'group-a', tenant_id: 'tenant' }],
    organization: [
      { id: 'primary-org', tenant_id: 'tenant', name: 'Primary', organization_group_id: 'group-a' },
      { id: 'secondary-org', tenant_id: 'tenant', name: 'Secondary', organization_group_id: 'group-b' },
      { id: 'unrelated', tenant_id: 'tenant', name: 'Unrelated', organization_group_id: 'group-b' },
    ],
    preference_field: [
      { id: 'type', name: 'type', tenant_id: 'tenant', entity_scope: 'organization', is_active: true },
      { id: 'department-name', name: 'name', tenant_id: 'tenant', entity_scope: 'custom_object',
        custom_object_id: 'departments', is_active: true },
    ],
    custom_object_definition: [{ id: 'departments', tenant_id: 'tenant', status: 'active', primary_display_field_id: 'department-name' }],
    custom_object_record: [
      { id: 'dept', tenant_id: 'tenant', custom_object_id: 'departments', archived_at: null, data: { name: 'Nuclear medicine' } },
      { id: 'assignment', tenant_id: 'tenant', custom_object_id: 'assignments', archived_at: null },
    ],
    custom_object_relationship_definition: [{ id: 'department-org', tenant_id: 'tenant', status: 'active',
      source_kind: 'organization', target_kind: 'custom_object', target_custom_object_id: 'departments', show_on_source: true }],
    custom_object_relationship: [
      { id: 'a', relationship_definition_id: 'member-assignment', source_record_id: 'assignment', target_record_id: 'member' },
      { id: 'b', relationship_definition_id: 'assignment-org', source_record_id: 'assignment', target_record_id: 'secondary-org' },
      { id: 'c', relationship_definition_id: 'department-org', source_record_id: 'primary-org', target_record_id: 'dept' },
    ].map(row => ({ ...row, tenant_id: 'tenant', archived_at: null })),
  };
  const db = { from(table) {
    const filters = []; let range;
    const q = { select() { return q; }, eq(k,v) { filters.push(r => r[k] === v); return q; },
      is(k,v) { filters.push(r => (r[k] ?? null) === v); return q; },
      in(k,vs) { filters.push(r => vs.includes(r[k])); return q; },
      order() { return q; }, range(a,b) { range = [a,b+1]; return q; },
      async maybeSingle() { return { data: result()[0] || null }; },
      then(resolve,reject) { return Promise.resolve({ data: result() }).then(resolve,reject); } };
    function result() {
      let rows = (tables[table] || []).filter(r => filters.every(f => f(r)));
      if (range) rows = rows.slice(...range);
      return rows;
    }
    return q;
  } };
  return { form, tables, db };
}

test('retains exact current primary/secondary records, never unrelated or JSON-forged authority', async () => {
  const { db, form } = fixture();
  await attachRetainedRenewalAffiliations({ db, form, tenantId: 'tenant', memberId: 'member' });
  assert(retainsOrganization(form.fields[1], 'primary-org'));
  assert(!retainsOrganization(form.fields[1], 'secondary-org'));
  assert(retainsOrganization(form.fields[3].child_fields[0], 'secondary-org'));
  assert(!retainsOrganization(form.fields[3].child_fields[0], 'unrelated'));
  assert(!retainsOrganization(JSON.parse(JSON.stringify(form.fields[1])), 'primary-org'));
  assert(await isOrganizationEligibleForField({ db, tenantId: 'tenant', organization: { id: 'primary-org' }, field: form.fields[1] }));
  assert(!await isOrganizationEligibleForField({ db, tenantId: 'tenant', organization: { id: 'unrelated' }, field: form.fields[1] }));
});

test('option lists restore existing filtered primary and other-trust secondary only for the member', async () => {
  for (const memberId of ['member', null, 'another-member']) {
    const { db } = fixture();
    const base = { db, tenantId: 'tenant', formSlug: 'renewal', sourceAnswers: { group: 'group-a' }, memberId };
    const primary = await loadConditionalOrganizationOptions({ ...base, fieldId: 'primary' });
    assert.deepEqual(primary.map(r => r.id), memberId === 'member' ? ['primary-org'] : []);
    const secondary = await loadConditionalOrganizationOptions({ ...base, fieldId: 'secondary', containerFieldId: 'sites' });
    assert.equal(secondary.some(r => r.id === 'secondary-org'), memberId === 'member');
    assert(!secondary.some(r => r.id === 'unrelated'));
  }
});

test('department lookup and submission keep relationship validation while permitting retained parent', async () => {
  const { db, form } = fixture();
  await attachRetainedRenewalAffiliations({ db, form, tenantId: 'tenant', memberId: 'member' });
  const service = createFormRelationshipService({ db, tenantId: 'tenant' });
  const options = await service.relationshipOptions({ form, fieldId: 'department', parentRecordId: 'primary-org' });
  assert.equal(options.data[0].id, 'dept');
  await service.validateSubmission({ form, submissionData: { primary: 'primary-org', department: ['dept'] }, hiddenFieldIds: new Set() });
  await assert.rejects(service.validateSubmission({ form, submissionData: { primary: 'primary-org', department: ['forged-dept'] }, hiddenFieldIds: new Set() }));
  await validateOrganisationGroupDependentOrganizationAnswers({ db, tenantId: 'tenant', fields: form.fields,
    submissionData: { group: 'group-a', primary: 'primary-org', sites: [{ secondary: 'secondary-org' }] } });
  await assert.rejects(validateOrganisationGroupDependentOrganizationAnswers({ db, tenantId: 'tenant', fields: form.fields,
    submissionData: { group: 'group-a', sites: [{ secondary: 'unrelated' }] } }));
});

test('cross-tenant, profile, and ordinary forms never acquire renewal exceptions', async () => {
  for (const kind of ['cross-tenant', 'profile', 'ordinary']) {
    const { db, form, tables } = fixture();
    if (kind === 'profile') tables.form_member_affiliation_config[0].config.purpose = 'profile';
    if (kind === 'ordinary') form.member_affiliation_enabled = false;
    await attachRetainedRenewalAffiliations({ db, form, tenantId: kind === 'cross-tenant' ? 'other' : 'tenant', memberId: 'member' });
    assert(!retainsOrganization(form.fields[1], 'primary-org'));
  }
});

test('additional-sites section remains available despite the selected trust and primary exclusion', async () => {
  const { db, form } = fixture();
  await attachRetainedRenewalAffiliations({ db, form, tenantId: 'tenant', memberId: 'member' });
  const hidden = await computeAuthoritativeHiddenFieldIds({ db, tenantId: 'tenant', form,
    formValues: { group: 'group-a', primary: 'primary-org', sites: [{ secondary: 'secondary-org' }] } });
  assert(!hidden.has('sites'));
});

test('archived assignments and removed edges cannot grant a retained exception', async () => {
  for (const archived of [true, false]) {
    const { db, form, tables } = fixture();
    if (archived) tables.custom_object_record.find(r => r.id === 'assignment').archived_at = '2026-01-01';
    else tables.custom_object_relationship[0].archived_at = '2026-01-01';
    await attachRetainedRenewalAffiliations({ db, form, tenantId: 'tenant', memberId: 'member' });
    assert(!retainsOrganization(form.fields[3].child_fields[0], 'secondary-org'));
  }
});
