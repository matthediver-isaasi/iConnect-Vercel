// Unit tests for boolean set_value coercion behaviour (Task #3666).
//
// Covers three related surfaces:
//   1. The coerceValueForField logic embedded in FormView / EmbedForm
//      (tested here as a pure extracted replica so no React env is needed).
//   2. The defensive boolean render check in FormRenderer (case-insensitive).
//   3. api/_lib/booleanCoercion.coerceBooleanPreferenceValue corner-cases
//      that previously caused "True" to pass through uncorrected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceBooleanPreferenceValue } from '../../../api/_lib/booleanCoercion.js';

// ---------------------------------------------------------------------------
// Pure replica of coerceValueForField (extracted from FormView/EmbedForm)
// ---------------------------------------------------------------------------

function coerceValueForField(value, fieldType) {
  if (value === null || value === undefined) return value;
  if (fieldType === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (['true', 'yes', 'y', 'on', '1'].includes(s)) return true;
    if (['false', 'no', 'n', 'off', '0'].includes(s)) return false;
    return value;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Boolean renderer checked-state logic (replica from FormRenderer case)
// ---------------------------------------------------------------------------

function computeBooleanChecked(value, defaultValue) {
  if (value !== undefined && value !== null) {
    return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
  }
  return defaultValue === true;
}

// ---------------------------------------------------------------------------
// coerceValueForField: boolean target field
// ---------------------------------------------------------------------------

test('coerceValueForField: passes null/undefined through unchanged', () => {
  assert.equal(coerceValueForField(null, 'boolean'), null);
  assert.equal(coerceValueForField(undefined, 'boolean'), undefined);
});

test('coerceValueForField: real booleans pass through unchanged', () => {
  assert.equal(coerceValueForField(true, 'boolean'), true);
  assert.equal(coerceValueForField(false, 'boolean'), false);
});

test('coerceValueForField: "True" (capital T) → true', () => {
  assert.equal(coerceValueForField('True', 'boolean'), true);
});

test('coerceValueForField: "TRUE" → true', () => {
  assert.equal(coerceValueForField('TRUE', 'boolean'), true);
});

test('coerceValueForField: lowercase "true" → true', () => {
  assert.equal(coerceValueForField('true', 'boolean'), true);
});

test('coerceValueForField: "yes" / "Yes" / "YES" → true', () => {
  assert.equal(coerceValueForField('yes', 'boolean'), true);
  assert.equal(coerceValueForField('Yes', 'boolean'), true);
  assert.equal(coerceValueForField('YES', 'boolean'), true);
});

test('coerceValueForField: "1" → true', () => {
  assert.equal(coerceValueForField('1', 'boolean'), true);
});

test('coerceValueForField: "False" / "FALSE" / "false" → false', () => {
  assert.equal(coerceValueForField('False', 'boolean'), false);
  assert.equal(coerceValueForField('FALSE', 'boolean'), false);
  assert.equal(coerceValueForField('false', 'boolean'), false);
});

test('coerceValueForField: "no" / "No" → false', () => {
  assert.equal(coerceValueForField('no', 'boolean'), false);
  assert.equal(coerceValueForField('No', 'boolean'), false);
});

test('coerceValueForField: "0" → false', () => {
  assert.equal(coerceValueForField('0', 'boolean'), false);
});

test('coerceValueForField: non-boolean field type is not coerced', () => {
  assert.equal(coerceValueForField('True', 'text'), 'True');
  assert.equal(coerceValueForField('yes', 'select'), 'yes');
  assert.equal(coerceValueForField('1', 'number'), '1');
});

test('coerceValueForField: unrecognised string for boolean passes through unchanged', () => {
  // Should not silently map to true or false
  assert.equal(coerceValueForField('maybe', 'boolean'), 'maybe');
  assert.equal(coerceValueForField('', 'boolean'), '');
});

// ---------------------------------------------------------------------------
// FormRenderer boolean checked-state: case-insensitive
// ---------------------------------------------------------------------------

test('computeBooleanChecked: real boolean true → checked', () => {
  assert.equal(computeBooleanChecked(true, false), true);
});

test('computeBooleanChecked: "true" (lowercase) → checked', () => {
  assert.equal(computeBooleanChecked('true', false), true);
});

test('computeBooleanChecked: "True" (capital T) → checked (defensive render)', () => {
  assert.equal(computeBooleanChecked('True', false), true);
});

test('computeBooleanChecked: "TRUE" → checked', () => {
  assert.equal(computeBooleanChecked('TRUE', false), true);
});

test('computeBooleanChecked: false → not checked', () => {
  assert.equal(computeBooleanChecked(false, true), false);
});

test('computeBooleanChecked: "false" → not checked', () => {
  assert.equal(computeBooleanChecked('false', true), false);
});

test('computeBooleanChecked: null falls back to default', () => {
  assert.equal(computeBooleanChecked(null, true), true);
  assert.equal(computeBooleanChecked(null, false), false);
});

test('computeBooleanChecked: undefined falls back to default', () => {
  assert.equal(computeBooleanChecked(undefined, true), true);
  assert.equal(computeBooleanChecked(undefined, false), false);
});

// ---------------------------------------------------------------------------
// coerceBooleanPreferenceValue: the shared server-side helper
// ---------------------------------------------------------------------------

test('coerceBooleanPreferenceValue: "True" → "true"', () => {
  assert.equal(coerceBooleanPreferenceValue('True'), 'true');
});

test('coerceBooleanPreferenceValue: "TRUE" → "true"', () => {
  assert.equal(coerceBooleanPreferenceValue('TRUE'), 'true');
});

test('coerceBooleanPreferenceValue: "False" → "false"', () => {
  assert.equal(coerceBooleanPreferenceValue('False'), 'false');
});

test('coerceBooleanPreferenceValue: real true/false → canonical strings', () => {
  assert.equal(coerceBooleanPreferenceValue(true), 'true');
  assert.equal(coerceBooleanPreferenceValue(false), 'false');
});

test('coerceBooleanPreferenceValue: null/undefined/"" → null', () => {
  assert.equal(coerceBooleanPreferenceValue(null), null);
  assert.equal(coerceBooleanPreferenceValue(undefined), null);
  assert.equal(coerceBooleanPreferenceValue(''), null);
});
