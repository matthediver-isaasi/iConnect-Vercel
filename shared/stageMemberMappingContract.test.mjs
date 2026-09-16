import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_MAPPING_CORE_FIELDS,
  normalizeTargetEntity,
  validateStageFieldMapping,
  validateMemberMappingAction,
} from './stageMemberMappingContract.js';

test('member mapping contract exposes only safe core fields', () => {
  assert.deepEqual(MEMBER_MAPPING_CORE_FIELDS, [
    'first_name',
    'last_name',
    'job_title',
    'mobile',
    'landline',
  ]);
  assert.equal(validateMemberMappingAction({
    id: 'action',
    target_entity: 'member',
    tenant_id: 'tenant',
    form_id: 'form',
    due_diligence_stage_id: 'approved',
    field_mappings: [{
      source_type: 'form_field',
      source_field_id: 'first',
      target_type: 'core',
      target_field: 'email',
    }],
  }, {
    tenantId: 'tenant',
    formId: 'form',
    stageId: 'approved',
    stageConfig: { workflow_stages: [{ id: 'approved' }] },
    sourceFormFields: [{ id: 'first' }],
  }).ok, false);
});

test('member mapping contract requires persisted stage and source membership', () => {
  const validation = validateMemberMappingAction({
    id: 'action',
    target_entity: 'member',
    tenant_id: 'tenant',
    form_id: 'form',
    due_diligence_stage_id: 'approved',
    field_mappings: [{
      source_type: 'form_field',
      source_field_id: 'missing',
      target_type: 'core',
      target_field: 'first_name',
    }],
  }, {
    tenantId: 'tenant',
    formId: 'form',
    stageId: 'approved',
    stageConfig: { workflow_stages: [{ id: 'rejected' }] },
    sourceFormFields: [{ id: 'first' }],
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(
    validation.errors.map(error => error.code),
    ['member_action_stage_not_configured', 'member_mapping_source_not_in_form'],
  );
});

test('action-level target entity defaults legacy rows to organization', () => {
  assert.equal(normalizeTargetEntity(undefined), 'organization');
  assert.equal(normalizeTargetEntity('member'), 'member');
  assert.equal(normalizeTargetEntity('credentials'), null);
});

test('member generic contract rejects unsafe core and non-scalar preference targets', () => {
  const sourceFields = [{ id: 'source' }];
  assert.equal(validateStageFieldMapping({
    source_type: 'form_field',
    source_field_id: 'source',
    target_type: 'core',
    target_field: 'email',
  }, { targetEntity: 'member', sourceFields }).ok, false);
  assert.equal(validateStageFieldMapping({
    source_type: 'form_field',
    source_field_id: 'source',
    target_type: 'custom',
    target_field: 'upload',
  }, {
    targetEntity: 'member',
    sourceFields,
    preferenceFields: [{
      id: 'upload',
      entity_scope: 'member',
      is_active: true,
      field_type: 'file',
    }],
    requireCustomFieldDefinition: true,
  }).ok, false);
});

test('member runtime contract rejects read-only and calculated preferences', () => {
  const sourceFields = [{ id: 'source' }];
  for (const preferenceField of [
    { id: 'readonly', entity_scope: 'member', is_active: true, field_type: 'text', read_only: true },
    { id: 'calculated', entity_scope: 'member', is_active: true, field_type: 'number', is_calculated: true },
    { id: 'formula', entity_scope: 'member', is_active: true, field_type: 'text', formula: 'source + 1' },
  ]) {
    assert.equal(validateStageFieldMapping({
      source_type: 'form_field',
      source_field_id: 'source',
      target_type: 'custom',
      target_field: preferenceField.id,
    }, {
      targetEntity: 'member',
      sourceFields,
      preferenceFields: [preferenceField],
      requireCustomFieldDefinition: true,
    }).ok, false, preferenceField.id);
  }
});
