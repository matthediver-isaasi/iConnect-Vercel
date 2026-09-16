import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  RESOLVE_RECORD_REFERENCES_OPERATION,
  compatibleRecordReferencePickers,
  includesNotListedRecord,
  NOT_LISTED_POLICY_SKIP,
  notListedPolicy,
  recordReferencePickerCompatibility,
  recordReferencePickerCapability,
  recordReferenceConfigurationWarning,
  withoutNotListedPolicy,
  withNotListedPolicy,
} from './formRecordReferenceResolver.js';

const formSchema = JSON.parse(await readFile(new URL('../schema/Form.json', import.meta.url), 'utf8'));

function schemaErrors(schema, value, root = formSchema) {
  if (schema.$ref) {
    const target = schema.$ref.slice('#/$defs/'.length).split('/')
      .reduce((current, key) => current?.[key], root.$defs);
    return schemaErrors(target, value, root);
  }
  const errors = [];
  if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) errors.push('not const');
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actual)) return [`expected ${types.join('|')}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.some(entry => Object.is(entry, value))) errors.push('not in enum');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`missing ${required}`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) errors.push(...schemaErrors(child, value[key], root).map(error => `${key}: ${error}`));
    }
  }
  for (const clause of schema.allOf || []) {
    if (clause.if) {
      const branch = schemaErrors(clause.if, value, root).length === 0 ? clause.then : clause.else;
      if (branch) errors.push(...schemaErrors(branch, value, root));
    } else {
      errors.push(...schemaErrors(clause, value, root));
    }
  }
  return errors;
}

function assertSchemaValid(schema, value) {
  assert.deepEqual(schemaErrors(schema, JSON.parse(JSON.stringify(value))), []);
}

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
  assert.equal(recordReferenceConfigurationWarning({
    ...action,
    not_listed_policy: NOT_LISTED_POLICY_SKIP,
  }, [picker]), '');
});

test('not-listed policy uses the surface-specific backwards-compatible default', () => {
  assert.equal(notListedPolicy({}), 'include');
  assert.equal(notListedPolicy({}, NOT_LISTED_POLICY_SKIP), 'skip');
  assert.equal(includesNotListedRecord({}), true);
  assert.equal(includesNotListedRecord({}, NOT_LISTED_POLICY_SKIP), false);
  assert.equal(includesNotListedRecord({ not_listed_policy: NOT_LISTED_POLICY_SKIP }), false);
});

test('policy state serializes, reloads, and validates for absent, include, skip, and transitions', () => {
  const actionSchema = formSchema.properties.structured_actions.properties.actions.items;
  const relatedSchema = formSchema.$defs.primaryPipelineRelatedRecord;
  const identity = {
    id: 'identity',
    source_type: 'not_listed_text',
    source_field_id: 'department',
    target_field_id: 'name',
    target_type: 'custom',
  };
  const relatedBase = {
    id: 'related-department',
    relationship_definition_id: 'department-member',
    source_field_id: 'department',
  };
  const includedRelated = {
    ...relatedBase,
    not_listed_policy: 'include',
    not_listed_operation: 'upsert',
    uniqueness_field: 'name',
    identity_mapping: identity,
    companion_mappings: [],
  };
  const legacyAction = {
    id: 'resolve-department',
    source: { scope: 'top_level' },
    target,
    operation: 'resolve_record_reference',
    reference_field_id: 'department',
    not_listed_operation: 'upsert',
    uniqueness_field: 'name',
    identity_mapping: identity,
    companion_mappings: [],
  };

  // JSON round-tripping represents a save/reopen boundary, rather than merely
  // asserting an in-memory object shape.
  assertSchemaValid(relatedSchema, relatedBase);
  assertSchemaValid(relatedSchema, includedRelated);
  assertSchemaValid(actionSchema, legacyAction);
  assertSchemaValid(actionSchema, { ...legacyAction, not_listed_policy: 'include' });

  const skippedRelated = withNotListedPolicy(includedRelated, 'skip', {
    defaultPolicy: NOT_LISTED_POLICY_SKIP,
  });
  const skippedAction = withNotListedPolicy(legacyAction, 'skip');
  assert.deepEqual(Object.hasOwn(skippedRelated, 'identity_mapping'), false);
  assert.deepEqual(Object.hasOwn(skippedAction, 'not_listed_operation'), false);
  assertSchemaValid(relatedSchema, skippedRelated);
  assertSchemaValid(actionSchema, skippedAction);

  const noLongerApplicable = withoutNotListedPolicy(skippedRelated);
  assert.deepEqual(Object.hasOwn(noLongerApplicable, 'not_listed_policy'), false);
  assertSchemaValid(relatedSchema, noLongerApplicable);
  assert.deepEqual(schemaErrors(relatedSchema, { ...relatedBase, not_listed_policy: null }).length > 0, true);
  assert.deepEqual(schemaErrors(actionSchema, { ...legacyAction, not_listed_policy: null }).length > 0, true);
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