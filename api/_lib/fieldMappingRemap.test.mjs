import test from 'node:test';
import assert from 'node:assert/strict';
import {
  remapFieldMappings,
  remapStageFieldMappingAction,
} from './fieldMappingRemap.js';

const sourceFields = [
  { id: 'old-first', label: 'First name', name: 'first' },
  { id: 'old-unused', label: 'Removed', name: 'removed' },
];
const targetFields = [
  { id: 'new-first', label: 'First name', name: 'first' },
];

test('field mapping copy remaps source ids and drops dangling source fields', () => {
  const result = remapFieldMappings([
    {
      source_type: 'form_field',
      source_field_id: 'old-first',
      target_type: 'core',
      target_field: 'first_name',
    },
    {
      source_type: 'form_field',
      source_field_id: 'old-unused',
      target_type: 'core',
      target_field: 'last_name',
    },
  ], sourceFields, targetFields);

  assert.deepEqual(result.mappings.map(mapping => mapping.source_field_id), ['new-first']);
  assert.equal(result.dropped.length, 1);
});

test('member action copy preserves target entity and validates safe custom destinations', () => {
  const result = remapStageFieldMappingAction({
    target_entity: 'member',
    field_mappings: [{
      source_type: 'static',
      static_value: 'Engineering',
      target_type: 'custom',
      target_field: 'member-segment',
    }],
  }, sourceFields, targetFields, {
    preferenceFields: [{
      id: 'member-segment',
      tenant_id: 'tenant',
      entity_scope: 'member',
      is_active: true,
      field_type: 'text',
    }],
    tenantId: 'tenant',
  });

  assert.equal(result.action.target_entity, 'member');
  assert.equal(result.action.field_mappings.length, 1);
});

test('member action copy drops unsafe core and non-scalar custom targets', () => {
  const result = remapStageFieldMappingAction({
    target_entity: 'member',
    field_mappings: [
      {
        source_type: 'static',
        static_value: 'secret',
        target_type: 'core',
        target_field: 'email',
      },
      {
        source_type: 'static',
        static_value: ['x'],
        target_type: 'custom',
        target_field: 'member-file',
      },
    ],
  }, sourceFields, targetFields, {
    preferenceFields: [{
      id: 'member-file',
      tenant_id: 'tenant',
      entity_scope: 'member',
      is_active: true,
      field_type: 'file',
    }],
    tenantId: 'tenant',
  });

  assert.equal(result.action.field_mappings.length, 0);
  assert.equal(result.dropped.length, 2);
});
