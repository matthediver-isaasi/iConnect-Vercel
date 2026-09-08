import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const builder = readFileSync(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8');
const schema = JSON.parse(readFileSync(new URL('../../../schema/Form.json', import.meta.url), 'utf8'));

test('Structured Record Actions persist an exact relationship selector field', () => {
  assert.match(builder, /selector_field_id/);
  assert.match(builder, /select-action-selector-field-/);
  assert.match(builder, /selector\.relationship_definition_id !== action\.relationship_definition_id/);
  assert.ok(schema.properties.structured_actions.properties.actions.items.properties.selector_field_id);
});

test('Structured Record Actions constrain references and upsert eligibility', () => {
  assert.match(builder, /isCompatibleStructuredMapping/);
  assert.match(builder, /sourceFamily === targetFamily/);
  assert.match(builder, /structuredUpsertFields/);
  assert.match(builder, /organization_group/);
});

test('builder exposes only explicit ordered fallback configuration', () => {
  assert.match(builder, /switch-mapping-fallback-/);
  assert.match(builder, /switch-structured-fallback-/);
  assert.match(builder, /first visible, non-empty source wins/);
  assert.match(builder, /Add at least two mappings to the same destination before enabling an ordered fallback/);
  assert.match(builder, /structuredFallbackErrors = validateExplicitFallbackGroups/);
  assert.match(builder, /item\.fallback_group\?\.id === groupId/);
  assert.ok(schema.properties.field_mappings.items.properties.fallback_group);
  assert.ok(schema.properties.structured_actions.properties.actions.items.properties.mappings.items.properties.fallback_group);
});

test('Form contract exposes backward-compatible generic relationship actions', () => {
  const action = schema.properties.structured_actions.properties.actions.items;
  assert.ok(action.properties.operation.enum.includes('link_relationship'));
  assert.ok(action.properties.source_endpoint);
  assert.ok(action.properties.target_endpoint);
  assert.deepEqual(
    action.properties.source_endpoint.properties.source.properties.type.enum,
    ['field', 'action_output'],
  );
  assert.deepEqual(
    action.properties.source_endpoint.properties.source.properties.scope.enum,
    ['form', 'row', null],
  );
  assert.deepEqual(action.allOf[0].then.required, [
    'relationship_definition_id', 'source_endpoint', 'target_endpoint',
  ]);
  assert.deepEqual(action.allOf[1].then.required, ['target', 'mappings']);
});

test('builder distinguishes Organisation Group hierarchy assignment from Data Studio links', () => {
  const action = schema.properties.structured_actions.properties.actions.items;
  assert.ok(action.properties.organization_group_source);
  assert.deepEqual(action.properties.organization_group_source.properties.type.enum, [
    'field', 'action_output',
  ]);
  assert.match(builder, /Assign to Organisation Group \(optional\)/);
  assert.match(builder, /built-in parent group/);
  assert.match(builder, /This is separate from a Data Studio relationship/);
  assert.match(builder, /select-organization-group-source-/);
  assert.match(builder, /Actions run from top to bottom/);
  assert.match(builder, /Move action \$\{actionIndex \+ 1\} earlier/);
});

test('builder and schema expose metadata-driven record-reference resolution', () => {
  const action = schema.properties.structured_actions.properties.actions.items;
  assert.ok(action.properties.operation.enum.includes('resolve_record_reference'));
  assert.ok(action.properties.operation.enum.includes('resolve_record_references'));
  assert.ok(action.properties.reference_field_id);
  assert.ok(action.properties.identity_mapping);
  assert.ok(action.properties.companion_mappings);
  assert.equal(action.properties.not_listed_operation.type, 'string');
  assert.deepEqual(action.properties.not_listed_operation.enum, ['create', 'upsert']);
  assert.deepEqual(action.allOf[2].then.required, [
    'target', 'reference_field_id', 'identity_mapping', 'companion_mappings', 'not_listed_operation',
  ]);
  assert.match(builder, /compatibleRecordReferencePickers/);
  assert.match(builder, /select-action-reference-field-/);
  assert.match(builder, /select-action-reference-identity-/);
  assert.match(builder, /Companion field mappings/);
  assert.match(builder, /compatible single-record picker/);
  assert.match(builder, /Resolve several record references/);
  assert.match(builder, /canonical collection/);
  assert.match(builder, /select-action-not-listed-operation-/);
  assert.match(builder, /Create a new record/);
  assert.match(builder, /Reuse or create by identity/);
  assert.match(builder, /resolverInitialConfig/);
  assert.match(builder, /not_listed_operation: 'upsert'/);
  assert.match(builder, /recordReferenceConfigurationWarning\(action, formData\.fields\)/);
});