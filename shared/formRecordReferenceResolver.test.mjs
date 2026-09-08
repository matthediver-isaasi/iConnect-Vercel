import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compatibleRecordReferencePickers,
  recordReferencePickerCompatibility,
  recordReferencePickerCapability,
  recordReferenceConfigurationWarning,
} from './formRecordReferenceResolver.js';

const target = { kind: 'custom_object', custom_object_id: 'department-object' };
const picker = {
  id: 'department',
  type: 'relationship_dropdown',
  related_kind: 'custom_object',
  related_custom_object_id: 'department-object',
  selection_mode: 'single',
  not_listed_choice: { enabled: true, label: 'Not listed' },
};

test('picker capability is metadata-driven and target-specific', () => {
  assert.deepEqual(recordReferencePickerCapability(picker).target, target);
  assert.equal(recordReferencePickerCompatibility(picker, target).compatible, true);
  assert.equal(recordReferencePickerCompatibility(picker, {
    kind: 'custom_object', custom_object_id: 'team-object',
  }).code, 'incompatible_target');
});

test('multi-record and ordinary not-listed fields cannot opt in accidentally', () => {
  assert.equal(recordReferencePickerCompatibility({ ...picker, selection_mode: 'multiple' }, target).code, 'multiple_selection');
  assert.equal(recordReferencePickerCompatibility({
    type: 'country',
    not_listed_choice: { enabled: true, label: 'Other' },
  }).code, 'unsupported_picker');
});

test('picker discovery preserves top-level and exact repeatable scope', () => {
  const fields = [
    picker,
    {
      id: 'rows',
      type: 'repeatable_row',
      repeatable_row: { children: [{ ...picker, id: 'row-department' }] },
    },
  ];
  assert.deepEqual(compatibleRecordReferencePickers(fields, { scope: 'top_level' }, target).map(f => f.id), ['department']);
  assert.deepEqual(compatibleRecordReferencePickers(fields, {
    scope: 'repeatable_row', repeatable_field_id: 'rows',
  }, target).map(f => f.id), ['row-department']);
});

test('configuration warning requires an explicit identity mapping', () => {
  const action = {
    operation: 'resolve_record_reference',
    source: { scope: 'top_level' },
    target,
    reference_field_id: 'department',
  };
  assert.match(recordReferenceConfigurationWarning(action, [picker]), /identity field/);
  assert.equal(recordReferenceConfigurationWarning({
    ...action,
    identity_mapping: { target_field_id: 'name', target_type: 'custom' },
  }, [picker]), 'Choose whether Not listed creates a record or upserts by its identity.');
  assert.equal(recordReferenceConfigurationWarning({
    ...action,
    not_listed_operation: 'upsert',
    identity_mapping: { target_field_id: 'name', target_type: 'custom' },
  }, [picker]), '');
});