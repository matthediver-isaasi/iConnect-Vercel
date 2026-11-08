import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraineeRenewal, TARGET } from './configure-trainee-renewal.mjs';

function fixture() {
  return {
    id: TARGET, tenant_id: 'ff2df806-b321-4254-b651-3af11fccf1db',
    name: 'Copy of Trainee join', slug: 'copy', is_active: false,
    member_affiliation_enabled: false, require_authentication: false,
    prefill_source: 'form_field', mutation_access_policy: null, due_diligence_required: true,
    uniqueness_checks: [{ target_field: 'member.email' }, { target_field: 'other' }],
    fields: [
      { id: 'field_1786371332409', type: 'country', label: 'Country' },
      { id: 'field_1788075690796', type: 'organisation_dropdown', label: 'Organisation',
        parent_field_id: 'missing-trust', parent_field_scope: 'form' },
      { id: 'field_1788075892819', type: 'relationship_dropdown', label: 'Departments',
        parent_field_id: 'field_1788075690796', relationship_definition_id: 'department-org' },
      { id: 'field_1788773081948', type: 'radio', label: 'Class', default_value: 'Trainee', options: ['Trainee'] },
      { id: 'payment', type: 'payment', label: 'Pay', membership_config_id: 'trainee-schedule',
        stripe_billing_address_mappings: [{ source: 'line1' }] },
      { id: 'email', type: 'email', label: 'Email' },
    ],
    pages: [],
    entity_pipelines: { members: [{ isPrimary: true, login_enabled: false,
      related_records: [{ source_field_id: 'field_1788075892819', relationship_definition_id: 'member-department' }],
      mappings: [
        { source_type: 'field', source_field_id: 'email', target_type: 'core', target_field: 'email' },
        { source_type: 'static', target_type: 'core', target_field: 'show_in_directory', static_value: 'False' },
        { source_type: 'static', target_type: 'communication', static_value: 'True' },
      ] }], organisations: [{ id: 'legacy-creation' }] },
    visibility_rules: [{ conditions: [{ field_id: 'field_1786371332409', operator: 'not_equals', value: 'United Kingdom' }],
      actions: [{ action_type: 'visibility', field_states: { payment: { visible: false } } },
        { action_type: 'open_form', destination_form_id: '8faff8a5-5671-41ef-a246-81810c34326d' }] }],
  };
}

test('trainee renewal retains questions and schedule, with owner auth and represented affiliations only', () => {
  const original = fixture();
  const before = structuredClone(original);
  const { form, config } = buildTraineeRenewal(original);
  assert.deepEqual(original, before);
  assert.equal(form.name, 'Trainee renew');
  assert.equal(form.slug, 'trainee-renew');
  assert.equal(form.is_active, false);
  assert.equal(form.require_authentication, true);
  assert.equal(form.mutation_access_policy.mode, 'authenticated_owner');
  assert.equal(form.due_diligence_required, false);
  assert.deepEqual(form.fields.map(f => f.label), original.fields.map(f => f.label));
  assert.deepEqual(form.uniqueness_checks, [{ target_field: 'other' }]);
  assert.equal(form.fields[1].parent_field_id, undefined);
  assert.equal(form.fields[2].parent_field_id, 'field_1788075690796');
  const payment = form.fields.find(f => f.id === 'payment');
  assert.equal(payment.type, 'membership_payment');
  assert.equal(payment.stripe_billing_address_mappings, undefined);
  assert.deepEqual(payment.membership_schedule_mapping.entries, [{ value: 'Trainee', config_id: 'trainee-schedule' }]);
  assert.deepEqual(config.primaryOrganizationFieldIds, ['field_1788075690796']);
  assert.equal(config.primaryDepartmentsFieldId, 'field_1788075892819');
  assert.equal(config.additionalSitesFieldId, undefined);
  assert.equal(config.organizationGroupFieldId, undefined);
  assert.equal(form.fields.find(f => f.id === 'email').prefill_field, 'member:email');
  assert.equal(form.entity_pipelines.members[0].mappings.length, 1);
  assert.equal(form.entity_pipelines.members[0].login_enabled, undefined);
  assert.deepEqual(form.entity_pipelines.members[0].related_records, []);
  assert.equal(form.visibility_rules[0].actions[1].destination_form_id, '824f5fda-7415-47f0-81a1-8bd85e589587');
});

test('configuration drift stops conversion instead of guessing membership class or department ownership', () => {
  const wrongClass = fixture();
  wrongClass.fields[3].options = ['Other'];
  assert.throws(() => buildTraineeRenewal(wrongClass));
  const missingRelationship = fixture();
  missingRelationship.entity_pipelines.members[0].related_records = [];
  assert.throws(() => buildTraineeRenewal(missingRelationship));
});
