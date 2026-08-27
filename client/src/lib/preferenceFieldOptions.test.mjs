import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePreferenceFieldOption,
  optionsForPreferenceFieldPayload,
  preparePreferenceFieldOptions
} from './preferenceFieldOptions.mjs';

test('normalizes legacy string options without changing their stored identity', () => {
  assert.deepEqual(normalizePreferenceFieldOption('Gold'), { value: 'Gold', label: 'Gold' });
});

test('a label-only edit preserves the original stored value', () => {
  const result = preparePreferenceFieldOptions([{ value: 'gold-tier', label: '  Premium Gold  ' }]);
  assert.equal(result.error, null);
  assert.deepEqual(result.options, [{ value: 'gold-tier', label: 'Premium Gold' }]);
});

test('rejects empty visible names', () => {
  const result = preparePreferenceFieldOptions([{ value: 'gold-tier', label: '   ' }]);
  assert.match(result.error, /visible name/i);
});

test('rejects empty and duplicate stored values', () => {
  assert.match(
    preparePreferenceFieldOptions([{ value: ' ', label: 'Blank' }]).error,
    /stored value/i
  );
  assert.match(
    preparePreferenceFieldOptions([
      { value: 'same-key', label: 'First' },
      { value: 'same-key', label: 'Second' }
    ]).error,
    /unique/i
  );
});

test('builds the saved dropdown payload with renamed labels and unchanged values', () => {
  assert.deepEqual(
    optionsForPreferenceFieldPayload('dropdown', [
      { value: 'original-key', label: 'Renamed label' },
      'Legacy option'
    ]),
    [
      { value: 'original-key', label: 'Renamed label' },
      { value: 'Legacy option', label: 'Legacy option' }
    ]
  );
  assert.equal(optionsForPreferenceFieldPayload('text', [{ value: 'x', label: 'X' }]), null);
});