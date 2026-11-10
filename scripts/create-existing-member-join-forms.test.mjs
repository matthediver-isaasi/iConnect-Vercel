import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExistingMemberJoin, COPIES, TENANT } from './create-existing-member-join-forms.mjs';
import { buildPrefillValues, resolveEffectivePrefillIds } from '../client/src/lib/formFieldPrefill.js';
import { resolveFormProcessingPrefillTargets } from '../api/_lib/formProcessingPolicy.js';

function source() {
  return {
    id: COPIES[0][0], tenant_id: TENANT, name: 'Full member join', slug: 'full-member-join',
    archived_at: null, is_active: true, submission_count: 20, survey_audit_log: [],
    require_authentication: false, member_affiliation_enabled: false, prefill_source: 'form_field',
    prefill_source_field_id: 'org', due_diligence_required: true, is_due_diligence_enabled: false,
    date_membership_config_id: null, additional_member_creations: [], pages: [{ id: 'page' }],
    fields: [
      { id: 'email', type: 'email' }, { id: 'name', type: 'text' }, { id: 'class', type: 'radio' },
      { id: 'org', type: 'organisation_dropdown' }, { id: 'group', type: 'organisation_group_dropdown' },
      { id: 'payment', type: 'payment', membership_config_id: 'schedule', price_field_id: 'class' },
    ],
    entity_pipelines: { members: [{ isPrimary: true, login_enabled: false, role_id: 'paid-role',
      mappings: [
        { source_type: 'field', source_field_id: 'email', target_type: 'core', target_field: 'email' },
        { source_type: 'field', source_field_id: 'name', target_type: 'core', target_field: 'first_name' },
        { source_type: 'field', source_field_id: 'class', target_type: 'custom', target_field: 'class-field' },
        { source_type: 'static', target_type: 'communication', static_value: 'True' },
        { source_type: 'static', target_type: 'core', target_field: 'show_in_directory', static_value: 'False' },
        { source_type: 'static', target_type: 'custom', target_field: 'application-status', static_value: 'Full application received' },
      ] }], organisations: [] },
    uniqueness_checks: [{ target_field: 'member.email' }, { target_field: 'other' }],
    visibility_rules: [{ actions: [
      { action_type: 'set_value', set_value_source: 'prefill', target_field_id: 'org-label' },
      { action_type: 'open_form', destination_form_id: COPIES[1][0] },
    ] }],
    structured_actions: { actions: [] }, submission_emails: [],
  };
}
test('copies retain questions, payment and approval while enabling signed-in owner prefill', () => {
  const original = source(), before = structuredClone(original);
  const copy = buildExistingMemberJoin(original, COPIES[0][1]);
  assert.deepEqual(original, before);
  assert.equal(copy.name, 'Full member join for existing member');
  assert.equal(copy.slug, 'full-member-join-for-existing-member');
  assert.equal(copy.is_active, false);
  assert.equal(copy.require_authentication, true);
  assert.equal(copy.mutation_access_policy.mode, 'authenticated_owner');
  assert.equal(copy.submission_count, 0);
  assert.equal(copy.due_diligence_required, true);
  assert.deepEqual(copy.uniqueness_checks, [{ target_field: 'other' }]);
  assert.equal(copy.entity_pipelines.members[0].login_enabled, undefined);
  assert.equal(copy.entity_pipelines.members[0].mappings.length, 4);
  assert.equal(copy.fields.find(f => f.id === 'class').prefill_field, undefined);
  assert.equal(copy.visibility_rules[0].actions[0].set_value_prefill_source_field_id, 'org');
  assert.equal(copy.visibility_rules[0].actions[1].destination_form_id, COPIES[1][1]);
  const member = { id: 'existing-guest', email: 'guest@example.test', first_name: 'Guest', organization_id: 'hospital' };
  const ids = resolveEffectivePrefillIds({ prefillSource: copy.prefill_source, viewerMemberId: member.id, viewerOrgId: member.organization_id });
  assert.equal(ids.prefillMemberId, member.id);
  const values = buildPrefillValues({ form: copy, memberEntity: member, orgEntity: { organization_group_id: 'trust' } });
  assert.equal(values.email, member.email);
  assert.equal(values.name, member.first_name);
  assert.equal(values.org, 'hospital');
  assert.equal(values.group, 'trust');
  assert.equal(resolveFormProcessingPrefillTargets({ isAdmin: false, submitterMember: member }).memberId, member.id);
});
test('unexpected tenant and additional members fail closed', () => {
  assert.throws(() => buildExistingMemberJoin({ ...source(), tenant_id: 'other' }, 'copy'));
  assert.throws(() => buildExistingMemberJoin({ ...source(), additional_member_creations: [{}] }, 'copy'));
});
