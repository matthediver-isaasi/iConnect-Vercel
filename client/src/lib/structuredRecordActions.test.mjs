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
  assert.deepEqual(action.allOf[0].else.required, ['target', 'mappings']);
});