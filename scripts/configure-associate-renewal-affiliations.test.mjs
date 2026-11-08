import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssociateAffiliations } from './configure-associate-renewal-affiliations.mjs';
import { validateMemberAffiliationConfig } from '../api/_lib/formMemberAffiliationConfig.js';
import { resolveMemberAffiliationAnswers } from '../api/_lib/formMemberAffiliationAnswers.js';

const primary = 'field_1788075690796';
const oldOrg = '00000000-0000-4000-8000-000000000001';
const newOrg = '00000000-0000-4000-8000-000000000002';
const original = {
  id: 'e86b2a16-e5bc-4c18-9329-6862cb2a2a4b',
  tenant_id: 'ff2df806-b321-4254-b651-3af11fccf1db',
  require_authentication: true, prefill_source: 'member', member_affiliation_enabled: false,
  mutation_access_policy: { mode: 'authenticated_owner' },
  fields: [{ id: primary, type: 'organisation_dropdown', parent_field_id: 'absent-group', parent_field_scope: 'form',
    org_filter: { type: 'custom', field: 'type', values: ['Hospital'] } },
  { id: 'field_1786371332409', type: 'country' },
  { id: 'pay', type: 'membership_payment', membership_schedule_mapping: { entries: [{ value: 'Associate', config_id: 'associate' }] } }],
  entity_pipelines: { members: [{ login_enabled: false, mappings: [{ target_field: 'email' }] }], organisations: [{ id: 'legacy' }] },
  visibility_rules: [{ id: 'legacy-name', conditions: [{ field_id: primary, operator: 'not_empty' }],
    actions: [{ target_field_id: 'field_1788942217508', action_type: 'set_value' }] }],
};

test('associate adaptation preserves every question and payment setting, with primary-only authority', () => {
  const before = structuredClone(original);
  const { form, config } = buildAssociateAffiliations(original);
  assert.deepEqual(original, before);
  assert.deepEqual(form.fields.map(f => f.id), original.fields.map(f => f.id));
  assert.deepEqual(form.fields[0].org_filter, original.fields[0].org_filter);
  assert.equal(form.fields[0].parent_field_id, undefined);
  assert.deepEqual(form.fields[2], original.fields[2]);
  assert.equal(form.entity_pipelines.members[0].login_enabled, undefined);
  assert.deepEqual(form.entity_pipelines.members[0].mappings, original.entity_pipelines.members[0].mappings);
  const validated = validateMemberAffiliationConfig(form, config, { complete: true, objects: [], relationships: [], fields: {} });
  assert.deepEqual(validated.primaryOrganizationFieldIds, [primary]);
  assert.equal(validated.primaryDepartmentsFieldId, null);
  assert.equal(validated.additionalSitesFieldId, null);
  assert.equal(validated.organizationGroupFieldId, null);
});

test('primary-only answers change a listed organisation and defer unlisted names to review', () => {
  const { form, config } = buildAssociateAffiliations(original);
  const snapshot = { member_id: 'member', config,
    graph: { organization_id: oldOrg, links: [], recordLinks: [], records: [] } };
  const resolve = answers => resolveMemberAffiliationAnswers({ form, snapshot, answers, hiddenFieldIds: new Set() });
  assert.equal(resolve({}).proposal.primary, oldOrg);
  assert.equal(resolve({ [primary]: newOrg }).proposal.primary, newOrg);
  const unlisted = resolve({ [primary]: '__form_not_listed__',
    __not_listed_choice_text: { [primary]: 'New hospital' } });
  assert.equal(unlisted.proposal.primary, oldOrg);
  assert.ok(JSON.stringify(unlisted).includes('New hospital'));
});
