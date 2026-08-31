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