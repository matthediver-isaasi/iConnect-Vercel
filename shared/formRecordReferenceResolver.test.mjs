import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESOLVE_RECORD_REFERENCES_OPERATION,
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
  assert.equal(recordReferencePickerCompatibility(
    { ...picker, selection_mode: 'multiple' },
    target,
    'multiple',
  ).compatible, true);
  assert.equal(recordReferencePickerCompatibility(picker, target, 'multiple').code, 'single_selection');
  assert.equal(recordReferencePickerCompatibility({
    type: 'country',
    not_listed_choice: { enabled: true, label: 'Other' },
  }).code, 'unsupported_picker');
});

test('fan-out configuration opts into only multi-record picker adapters', () => {
  const multiPicker = { ...picker, selection_mode: 'multiple' };
  const action = {
    operation: RESOLVE_RECORD_REFERENCES_OPERATION,
    source: { scope: 'top_level' },
    target,
    reference_field_id: multiPicker.id,
    not_listed_operation: 'upsert',
    identity_mapping: { target_field_id: 'name', target_type: 'custom' },
  };
  assert.deepEqual(
    compatibleRecordReferencePickers([picker, multiPicker], action.source, target, 'multiple')
      .map(field => field.id),
    [multiPicker.id],
  );
  assert.equal(recordReferenceConfigurationWarning(action, [multiPicker]), '');
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

test('record-backed row sources advertise their action descriptor but distinct and malformed sources do not', () => {
  const source = {
    type: 'relationship_dropdown',
    option_source: {
      version: 1,
      kind: 'records',
      custom_object_id: '10000000-0000-0000-0000-000000000001',
      primary_display_field_id: '10000000-0000-0000-0000-000000000002',
      filters: [],
    },
  };
  assert.equal(recordReferencePickerCapability(source)?.target?.custom_object_id,
    source.option_source.custom_object_id);
  assert.equal(recordReferencePickerCapability({
    ...source,
    option_source: {
      ...source.option_source,
      kind: 'distinct',
      value_field_id: '10000000-0000-0000-0000-000000000003',
    },
  }), null);
  assert.equal(recordReferencePickerCapability({
    ...source,
    option_source: { ...source.option_source, forged: true },
  }), null);
  assert.equal(recordReferencePickerCapability({
    ...source,
    selection_mode: 'multiple',
  }), null);
  assert.equal(recordReferencePickerCapability({
    ...source,
    not_listed_choice: { enabled: true, label: 'Other' },
  }), null);
});