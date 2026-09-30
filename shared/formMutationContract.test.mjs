import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assessFormMutationAccess,
  classifyFormMutationContract,
  FORM_RECORD_ACCESS,
  hasFormMutationConfigChanged,
  supportsApplicantContinuationIssuance,
  validateFormMutationAccessSave,
} from './formMutationContract.js';

test('classifies current mapped updates and legacy create separately', () => {
  const current = classifyFormMutationContract({
    fields: [{ id: 'phone', type: 'text' }],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: 'org',
        label: 'Applicant organisation',
        mappings: [{
          source_field_id: 'phone',
          target_type: 'core',
          target_field: 'phone',
        }],
      }],
    },
  });
  assert.equal(current.targets.organization.classification, FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING);
  assert.deepEqual(current.mutationTargets, ['organization']);

  const legacy = classifyFormMutationContract({
    entity_pipelines: null,
    create_entity_type: 'member',
    member_entity_action: 'create',
  });
  assert.equal(legacy.targets.member.classification, FORM_RECORD_ACCESS.CREATE_ONLY);
  assert.equal(legacy.hasExistingRecordMutation, false);
});

test('classifies legacy update and additional member identity matching as mutations', () => {
  const result = classifyFormMutationContract({
    entity_pipelines: null,
    fields: [{ id: 'phone', type: 'text' }],
    field_mappings: [{
      source_field_id: 'phone',
      target_entity: 'organization',
      target_type: 'core',
      target_field: 'phone',
    }],
    member_entity_action: 'create',
    organization_entity_action: 'update',
    additional_member_creations: [{
      id: 'second',
      label: 'Second contact',
      mappings: [{ source_field_id: 'phone', target_type: 'core', target_field: 'mobile' }],
    }],
  });
  assert.equal(result.targets.organization.classification, FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING);
  assert.equal(result.targets.member.classification, FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING);
});

test('does not invent legacy actions from defaults', () => {
  for (const form of [
    {},
    { entity_pipelines: null },
    { entity_pipelines: null, create_entity_type: 'member' },
    { entity_pipelines: null, entity_action: 'create' },
  ]) {
    assert.equal(classifyFormMutationContract(form).hasExistingRecordMutation, false);
    assert.equal(classifyFormMutationContract(form).targets.member.classification, FORM_RECORD_ACCESS.NONE);
  }
});

test('classifies a pure organisation picker pipeline as reference-only', () => {
  const base = {
    fields: [{ id: 'org', type: 'organisation_dropdown' }],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: 'org-pipeline',
        mappings: [{
          source_field_id: 'org',
          target_type: 'core',
          target_field: 'name',
        }],
      }],
    },
  };
  assert.equal(
    classifyFormMutationContract(base).targets.organization.classification,
    FORM_RECORD_ACCESS.REFERENCE_ONLY,
  );
  assert.equal(
    classifyFormMutationContract({
      ...base,
      fields: [{
        id: 'org',
        type: 'organisation_dropdown',
        not_listed_choice: { enabled: true, label: 'My organisation is not listed' },
      }],
    }).targets.organization.classification,
    FORM_RECORD_ACCESS.CREATE_ONLY,
  );
  assert.equal(
    classifyFormMutationContract({
      ...base,
      fields: [...base.fields, { id: 'phone', type: 'text' }],
      entity_pipelines: {
        members: [],
        organisations: [{
          ...base.entity_pipelines.organisations[0],
          mappings: [
            ...base.entity_pipelines.organisations[0].mappings,
            { source_field_id: 'phone', target_type: 'core', target_field: 'phone' },
          ],
        }],
      },
    }).targets.organization.classification,
    FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING,
  );
  assert.equal(
    classifyFormMutationContract({
      entity_pipelines: { members: [], organisations: [{ id: 'empty', mappings: [] }] },
    }).targets.organization.classification,
    FORM_RECORD_ACCESS.REFERENCE_ONLY,
  );
});

test('classifies a pure member picker pipeline as reference-only', () => {
  const result = classifyFormMutationContract({
    fields: [{ id: 'member', type: 'member_dropdown' }],
    entity_pipelines: {
      members: [{
        id: 'member-pipeline',
        mappings: [{
          source_field_id: 'member',
          target_type: 'core',
          target_field: 'email',
        }],
      }],
      organisations: [],
    },
  });
  assert.equal(result.targets.member.classification, FORM_RECORD_ACCESS.REFERENCE_ONLY);
  assert.equal(result.hasExistingRecordMutation, false);
});

test('keeps selected references harmless but detects explicit Not-listed upserts', () => {
  const reference = {
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: {
      version: 1,
      actions: [{
        id: 'resolve-org',
        operation: 'resolve_record_reference',
        target: { kind: 'organization' },
      }],
    },
  };
  assert.equal(
    classifyFormMutationContract(reference).targets.organization.classification,
    FORM_RECORD_ACCESS.REFERENCE_ONLY,
  );

  reference.structured_actions.actions[0] = {
    ...reference.structured_actions.actions[0],
    not_listed_policy: 'include',
    not_listed_operation: 'upsert',
  };
  assert.equal(
    classifyFormMutationContract(reference).targets.organization.classification,
    FORM_RECORD_ACCESS.MAY_MUTATE_EXISTING,
  );
});

test('applicant continuation supports organization-scoped member mutation', () => {
  const organizationForm = {
    require_authentication: false,
    fields: [{ id: 'phone', type: 'text' }, { id: 'first', type: 'text' }],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: 'org',
        mappings: [{ source_field_id: 'phone', target_type: 'core', target_field: 'phone' }],
      }],
    },
    mutation_access_policy: { version: 1, mode: 'applicant_continuation' },
  };
  assert.equal(assessFormMutationAccess(organizationForm).ok, true);

  const organizationMemberForm = {
    ...organizationForm,
    entity_pipelines: {
      members: [{ id: 'member' }],
      organisations: organizationForm.entity_pipelines.organisations,
    },
  };
  organizationMemberForm.entity_pipelines.members[0].mappings = [
    { source_field_id: 'first', target_type: 'core', target_field: 'first_name' },
  ];
  assert.equal(assessFormMutationAccess(organizationMemberForm).ok, true);

  const memberOnlyForm = {
    ...organizationForm,
    entity_pipelines: {
      members: [{
        id: 'member',
        mappings: [{ source_field_id: 'first', target_type: 'core', target_field: 'first_name' }],
      }],
      organisations: [],
    },
  };
  const result = assessFormMutationAccess(memberOnlyForm);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT');
});

test('legacy organization mutation supports secure issuance without authorizing bare links', () => {
  const legacy = {
    entity_pipelines: null,
    require_authentication: false,
    fields: [{ id: 'phone', type: 'text' }],
    field_mappings: [{
      source_field_id: 'phone',
      target_entity: 'organization',
      target_type: 'core',
      target_field: 'phone',
    }],
    organization_entity_action: 'update',
  };
  assert.equal(supportsApplicantContinuationIssuance(legacy), true);
  assert.equal(assessFormMutationAccess(legacy).ok, false);
  assert.equal(supportsApplicantContinuationIssuance({
    ...legacy,
    mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
  }), false);
});

test('structured mutation actions cannot use applicant continuation', () => {
  const base = {
    require_authentication: false,
    fields: [{ id: 'phone', type: 'text' }],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: 'org',
        mappings: [{ source_field_id: 'phone', target_type: 'core', target_field: 'phone' }],
      }],
    },
    mutation_access_policy: { version: 1, mode: 'applicant_continuation' },
  };
  for (const action of [
    { id: 'update', operation: 'update_selected', target: { kind: 'custom_object' } },
    { id: 'upsert', operation: 'upsert', target: { kind: 'organization' } },
    {
      id: 'resolver',
      operation: 'resolve_record_reference',
      target: { kind: 'organization' },
      not_listed_operation: 'upsert',
    },
  ]) {
    const form = {
      ...base,
      structured_actions: { version: 1, actions: [action] },
    };
    const assessment = assessFormMutationAccess(form);
    assert.equal(assessment.ok, false);
    assert.match(assessment.error, /authenticated-owner/);
    assert.equal(assessment.hasUnsupportedApplicantContinuationMutation, true);
    assert.equal(supportsApplicantContinuationIssuance(form), false);
  }
});

test('unchanged legacy structured mutation remains save-compatible but cannot issue continuation', () => {
  const legacy = {
    is_active: true,
    require_authentication: false,
    fields: [{ id: 'phone', type: 'text' }],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: 'org',
        mappings: [{ source_field_id: 'phone', target_type: 'core', target_field: 'phone' }],
      }],
    },
    structured_actions: {
      version: 1,
      actions: [{ id: 'update', operation: 'update', target: { kind: 'organization' } }],
    },
  };
  assert.match(assessFormMutationAccess(legacy).error, /authenticated-owner/);
  assert.equal(supportsApplicantContinuationIssuance(legacy), false);
  assert.equal(validateFormMutationAccessSave({
    form: { ...legacy, name: 'Metadata only' },
    previousForm: legacy,
  }).legacyCompatibility, true);
});

test('authenticated owner mode requires login and never infers authority from login alone', () => {
  const form = {
    fields: [{ id: 'phone', type: 'text' }],
    entity_pipelines: {
      members: [],
      organisations: [{
        id: 'org',
        mappings: [{ source_field_id: 'phone', target_type: 'core', target_field: 'phone' }],
      }],
    },
    require_authentication: true,
  };
  assert.equal(assessFormMutationAccess(form).ok, false);
  assert.equal(assessFormMutationAccess({
    ...form,
    mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
  }).ok, true);
  assert.equal(assessFormMutationAccess({
    ...form,
    require_authentication: false,
    mutation_access_policy: { version: 1, mode: 'authenticated_owner' },
  }).ok, false);
});

test('modern public member signup is an upsert while explicit legacy create remains create-only', () => {
  const modern = {
    require_authentication: false,
    fields: [{ id: 'email', type: 'email' }],
    entity_pipelines: {
      members: [{
        id: 'signup',
        uniqueness_key: 'email',
        mappings: [{
          source_field_id: 'email',
          target_type: 'core',
          target_field: 'email',
        }],
      }],
      organisations: [],
    },
  };
  const assessment = assessFormMutationAccess(modern);
  assert.equal(assessment.ok, false);
  assert.match(assessment.error, /not a create-only signup contract/i);

  const legacyCreate = assessFormMutationAccess({
    entity_pipelines: null,
    create_entity_type: 'member',
    member_entity_action: 'create',
  });
  assert.equal(legacyCreate.ok, true);
  assert.equal(legacyCreate.targets.member.classification, FORM_RECORD_ACCESS.CREATE_ONLY);
});

test('inactive drafts save and unchanged active legacy forms remain compatible', () => {
  const legacy = {
    is_active: true,
    require_authentication: false,
    entity_pipelines: null,
    organization_entity_action: 'update',
    fields: [{ id: 'name' }],
    field_mappings: [{
      source_field_id: 'name',
      target_entity: 'organization',
      target_type: 'core',
      target_field: 'phone',
    }],
  };
  assert.equal(validateFormMutationAccessSave({
    form: { ...legacy, name: 'Renamed' },
    previousForm: legacy,
  }).legacyCompatibility, true);
  const draft = validateFormMutationAccessSave({
    form: { ...legacy, is_active: false, fields: [{ id: 'changed' }] },
    previousForm: legacy,
  });
  assert.equal(draft.ok, true);
  assert.match(draft.draftWarning, /applicant continuation/i);
  assert.equal(validateFormMutationAccessSave({
    form: { ...legacy, fields: [{ id: 'changed' }] },
    previousForm: legacy,
  }).ok, false);
  assert.equal(validateFormMutationAccessSave({
    form: legacy,
    isCreate: true,
  }).ok, false, 'new and copied-active forms must declare authority');
});

test('mutation config comparison ignores metadata but catches mappings', () => {
  assert.equal(hasFormMutationConfigChanged({ name: 'A' }, { name: 'B' }), false);
  assert.equal(hasFormMutationConfigChanged(
    { field_mappings: [{ id: 'one' }] },
    { field_mappings: [{ id: 'two' }] },
  ), true);
});

test('sanitized real GFI fixtures retain member and organization mutation classification', () => {
  for (const fixtureName of [
    '57b94fc2-359d-434c-acd6-794865797ade.json',
    'a47f37f1-b14a-4aea-8aee-cd0ebf7d9a8b.json',
  ]) {
    const fixture = JSON.parse(readFileSync(
      new URL(`../tests/fixtures/form-compatibility/${fixtureName}`, import.meta.url),
      'utf8',
    ));
    const result = classifyFormMutationContract(fixture.structure);
    assert.deepEqual(
      result.mutationTargets,
      ['member', 'organization'],
      `${fixtureName} must keep both intended update families`,
    );
  }
});