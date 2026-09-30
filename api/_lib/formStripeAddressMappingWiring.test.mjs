import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const updateSource = readFileSync(
  new URL('../entities/[entity]/[id].js', import.meta.url),
  'utf8',
);
const builderSource = readFileSync(
  new URL('../../client/src/pages/FormBuilder.jsx', import.meta.url),
  'utf8',
);

test('Form PATCH validation reloads and triggers on every legacy resolution field', () => {
  for (const field of [
    'auto_create_entity',
    'create_entity_type',
    'entity_action',
    'member_entity_action',
    'organization_entity_action',
  ]) {
    assert.match(
      updateSource,
      new RegExp(`['"]${field}['"]`),
      `missing PATCH validation trigger for ${field}`,
    );
    assert.match(
      updateSource,
      new RegExp(`\\.select\\([^\\n]*${field}`),
      `missing persisted Form select for ${field}`,
    );
  }
});

test('FormBuilder gives Stripe compatibility validation the full form config', () => {
  assert.match(builderSource, /formConfig=\{formData\}/);
  assert.match(builderSource, /const mappingForm = formConfig \|\|/);
});