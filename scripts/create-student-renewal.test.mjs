import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStudentRenewal, SOURCE, TARGET } from './create-student-renewal.mjs';
import { validateMemberAffiliationConfig } from '../api/_lib/formMemberAffiliationConfig.js';

test('student renewal is a separate inactive copy with the same questions and university-only scope', () => {
  const source = {
    id: SOURCE, tenant_id: 'ff2df806-b321-4254-b651-3af11fccf1db', archived_at: null,
    name: 'Student join', slug: 'student-join', is_active: true, submission_count: 1,
    fields: [{ id: 'field_1787065791684', type: 'organisation_dropdown', label: 'University' },
      { id: 'country', type: 'country', label: 'Study country' },
      { id: 'end', type: 'date', label: 'Course end date' }],
    pages: [{ id: 'study', title: 'Study' }], uniqueness_checks: [{ target_field: 'member.email' }],
    entity_pipelines: { members: [{ isPrimary: true, login_enabled: false, mappings: [
      { source_type: 'static', target_type: 'custom', target_field: '87f120ff-92e6-4d52-944b-9ba9d7b1fac0', static_value: 'Student' },
      { source_type: 'field', source_field_id: 'country', target_type: 'custom', target_field: 'study-country' },
      { source_type: 'field', source_field_id: 'end', target_type: 'custom', target_field: 'course-end' },
      { source_type: 'static', target_type: 'communication', static_value: 'True' },
    ] }], organisations: [{ id: 'create' }] },
    visibility_rules: [{ actions: [{ action_type: 'set_value', target_field_id: 'field_1788939115747' }] }],
  };
  const before = structuredClone(source);
  const { form, config } = buildStudentRenewal(source);
  assert.deepEqual(source, before);
  assert.equal(form.id, TARGET);
  assert.equal(form.name, 'Student renew');
  assert.equal(form.slug, 'student-renew');
  assert.equal(form.is_active, false);
  assert.equal(form.submission_count, 0);
  assert.equal(form.require_authentication, true);
  assert.equal(form.due_diligence_required, false);
  assert.deepEqual(form.uniqueness_checks, []);
  assert.equal(form.fields[1].prefill_field, 'member_custom:study-country');
  assert.equal(form.fields[2].prefill_field, 'member_custom:course-end');
  assert.equal(form.fields.some(f => f.type.includes('payment')), false);
  assert.equal(form.entity_pipelines.members[0].mappings[0].static_value, 'Student');
  const checked = validateMemberAffiliationConfig(form, config, { complete: true, objects: [], fields: {}, relationships: [] });
  assert.deepEqual(checked.primaryOrganizationFieldIds, ['field_1787065791684']);
  assert.equal(checked.primaryDepartmentsFieldId, null);
  assert.equal(checked.additionalSitesFieldId, null);
  assert.equal(checked.organizationCountryFieldId, undefined);
});
