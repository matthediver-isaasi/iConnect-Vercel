import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMemberCustomPreferenceValue } from './memberCustomMapping.js';

const ceoField = { id: 'ceo-field', field_type: 'boolean' };

test('DD member custom mapping stores production-shaped Yes/No strings canonically', () => {
  assert.deepEqual(prepareMemberCustomPreferenceValue('Yes', ceoField), {
    ok: true,
    storedValue: 'true',
  });
  assert.deepEqual(prepareMemberCustomPreferenceValue('No', ceoField), {
    ok: true,
    storedValue: 'false',
  });
});

test('DD member custom mapping reports unresolved, ambiguous, and missing-definition values', () => {
  assert.deepEqual(prepareMemberCustomPreferenceValue('', ceoField), {
    ok: false,
    reason: 'unresolved_input',
  });
  assert.deepEqual(prepareMemberCustomPreferenceValue('maybe', ceoField), {
    ok: false,
    reason: 'unsupported_boolean_coercion',
  });
  assert.deepEqual(prepareMemberCustomPreferenceValue('Yes', undefined), {
    ok: false,
    reason: 'missing_preference_definition',
  });
});

test('DD member custom mapping preserves non-boolean storage behavior', () => {
  assert.deepEqual(
    prepareMemberCustomPreferenceValue(['one', 'two'], { id: 'text-field', field_type: 'text' }),
    { ok: true, storedValue: '["one","two"]' },
  );
});