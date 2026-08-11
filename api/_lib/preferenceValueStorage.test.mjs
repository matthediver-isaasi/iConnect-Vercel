// Regression tests for canonical boolean storage in the form pipeline
// preference mapping (coercePreferenceValueForStorage). A radio/select
// answer like "Yes" mapped onto a boolean-typed custom preference field
// must be stored as the canonical 'true'/'false' strings that all boolean
// readers check (value === 'true'), and ambiguous values must be skipped
// (undefined) rather than silently stored as a false-reading string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coercePreferenceValueForStorage } from './preferenceValueStorage.js';

const boolField = { id: 'pf-bool', field_type: 'boolean' };

test('boolean field: Yes/No radio values store canonically', () => {
  assert.equal(coercePreferenceValueForStorage('Yes', boolField), 'true');
  assert.equal(coercePreferenceValueForStorage('No', boolField), 'false');
  assert.equal(coercePreferenceValueForStorage('yes', boolField), 'true');
  assert.equal(coercePreferenceValueForStorage('NO', boolField), 'false');
});

test('boolean field: 1/0, on/off, true/false variants', () => {
  assert.equal(coercePreferenceValueForStorage(1, boolField), 'true');
  assert.equal(coercePreferenceValueForStorage(0, boolField), 'false');
  assert.equal(coercePreferenceValueForStorage('1', boolField), 'true');
  assert.equal(coercePreferenceValueForStorage('0', boolField), 'false');
  assert.equal(coercePreferenceValueForStorage('on', boolField), 'true');
  assert.equal(coercePreferenceValueForStorage('off', boolField), 'false');
  assert.equal(coercePreferenceValueForStorage(true, boolField), 'true');
  assert.equal(coercePreferenceValueForStorage(false, boolField), 'false');
  assert.equal(coercePreferenceValueForStorage('True', boolField), 'true');
});

test('boolean field: checkbox array and wrapper shapes', () => {
  assert.equal(coercePreferenceValueForStorage(['Yes'], boolField), 'true');
  assert.equal(coercePreferenceValueForStorage(['no'], boolField), 'false');
  assert.equal(coercePreferenceValueForStorage({ value: 'yes' }, boolField), 'true');
  assert.equal(coercePreferenceValueForStorage({ checked: false }, boolField), 'false');
});

test('boolean field: ambiguous values are skipped (undefined), not stored false', () => {
  assert.equal(coercePreferenceValueForStorage('maybe', boolField), undefined);
  assert.equal(coercePreferenceValueForStorage(['yes', 'no'], boolField), undefined);
  assert.equal(coercePreferenceValueForStorage(2, boolField), undefined);
  assert.equal(coercePreferenceValueForStorage('', boolField), undefined);
  assert.equal(coercePreferenceValueForStorage(null, boolField), undefined);
  assert.equal(coercePreferenceValueForStorage({ foo: 1 }, boolField), undefined);
});

test('non-boolean fields untouched: arrays/objects JSON-stringify, scalars stringify', () => {
  const textField = { id: 'pf-text', field_type: 'text' };
  assert.equal(coercePreferenceValueForStorage('Yes', textField), 'Yes');
  assert.equal(coercePreferenceValueForStorage(['a', 'b'], textField), JSON.stringify(['a', 'b']));
  assert.equal(coercePreferenceValueForStorage({ a: 1 }, textField), JSON.stringify({ a: 1 }));
  assert.equal(coercePreferenceValueForStorage(42, textField), '42');
  // No field definition available — behave as before (stringify).
  assert.equal(coercePreferenceValueForStorage('Yes', undefined), 'Yes');
  assert.equal(coercePreferenceValueForStorage(['x'], null), JSON.stringify(['x']));
});

// Simulated pipeline pass: the convertMapToArray contract — entries whose
// boolean coercion is ambiguous are dropped from the write set.
test('pipeline map conversion skips ambiguous boolean entries only', () => {
  const prefFieldMap = new Map([
    ['pf-bool', boolField],
    ['pf-text', { id: 'pf-text', field_type: 'text' }],
  ]);
  const map = new Map([
    ['pf-bool', 'Yes'],
    ['pf-text', 'hello'],
  ]);
  const result = [];
  for (const [fieldId, value] of map.entries()) {
    const stored = coercePreferenceValueForStorage(value, prefFieldMap.get(fieldId));
    if (stored === undefined) continue;
    result.push({ field_id: fieldId, value: stored });
  }
  assert.deepEqual(result, [
    { field_id: 'pf-bool', value: 'true' },
    { field_id: 'pf-text', value: 'hello' },
  ]);

  const ambiguous = coercePreferenceValueForStorage('perhaps', prefFieldMap.get('pf-bool'));
  assert.equal(ambiguous, undefined);
});

// Task #3520 regression: a Yes/No radio pipeline-mapped (entity_pipelines
// mappings array, target_type 'custom') to a boolean custom field must store
// canonical 'true'/'false' on BOTH write paths in process-application.js:
//   - new-member create: memberCustomFieldsMap -> convertMapToArray -> upsert
//   - existing/additional-member update: per-entry inline coercion before
//     upsertPreferenceValue (skips empty and ambiguous values).
test('pipeline mappings: Yes/No radio stores canonically on new-member and existing-member paths', () => {
  const prefFieldMap = new Map([['pf-bool', boolField]]);

  // New-member path contract (convertMapToArray).
  const newMemberWrites = [];
  for (const [fieldId, value] of new Map([['pf-bool', 'Yes']]).entries()) {
    const stored = coercePreferenceValueForStorage(value, prefFieldMap.get(fieldId));
    if (stored === undefined) continue;
    newMemberWrites.push({ field_id: fieldId, value: stored });
  }
  assert.deepEqual(newMemberWrites, [{ field_id: 'pf-bool', value: 'true' }]);

  // Existing-member path contract: guard on empty, then coerce, skip undefined.
  const existingMemberWrite = (value) => {
    if (value === undefined || value === null || value === '') return null; // skipped
    const stored = coercePreferenceValueForStorage(value, prefFieldMap.get('pf-bool'));
    if (stored === undefined) return null; // ambiguous — skipped
    return { field_id: 'pf-bool', value: stored };
  };
  assert.deepEqual(existingMemberWrite('Yes'), { field_id: 'pf-bool', value: 'true' });
  assert.deepEqual(existingMemberWrite('No'), { field_id: 'pf-bool', value: 'false' });
  assert.equal(existingMemberWrite(''), null);
  assert.equal(existingMemberWrite('maybe'), null);
});
