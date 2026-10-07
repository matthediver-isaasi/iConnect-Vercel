import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_FIELD_TYPES, buildCustomFieldValues, buildCustomFieldDefinitions, copyCustomFieldValues, populatedCustomFieldDisplay, formatCustomFieldValue } from './memberGroupCustomFields.mjs';

const fields = CUSTOM_FIELD_TYPES.map(([type]) => ({ id: `id-${type}`, name: type, type, choices: type === 'select' ? ['Regional', 'National'] : [] }));

test('all eight types produce typed explicit replacement values and discard orphan IDs', () => {
  assert.deepEqual(buildCustomFieldValues(fields, {
    'id-text': 'A group', 'id-textarea': 'First line\nSecond line', 'id-number': '0',
    'id-date': '2028-02-29', 'id-select': 'Regional', 'id-boolean': false,
    'id-email': 'team@example.org', 'id-url': 'https://example.org/team',
    retired: 'must not be sent',
  }), {
    'id-text': 'A group', 'id-textarea': 'First line\nSecond line', 'id-number': 0,
    'id-date': '2028-02-29', 'id-select': 'Regional', 'id-boolean': false,
    'id-email': 'team@example.org', 'id-url': 'https://example.org/team',
  });
});

test('unset boolean is distinct from No; blank inputs explicitly clear the replacement object', () => {
  assert.deepEqual(buildCustomFieldValues(fields, { 'id-boolean': '', 'id-text': '  ', 'id-number': '' }), {});
  assert.deepEqual(buildCustomFieldValues(fields, { 'id-boolean': false }), { 'id-boolean': false });
  assert.deepEqual(buildCustomFieldValues(fields, { 'id-boolean': true }), { 'id-boolean': true });
  assert.deepEqual(buildCustomFieldValues(fields), {});
});

test('invalid typed values are rejected before a group save', () => {
  for (const [type, value] of [
    ['number', 'NaN'], ['boolean', 'false'], ['select', 'Retired'], ['date', '2027-02-29'],
    ['email', 'missing-at.example.org'], ['url', 'javascript:alert(1)'], ['url', 'https://user:secret@example.org'],
    ['text', 'first\nsecond'], ['textarea', 'x'.repeat(10001)],
  ]) assert.throws(() => buildCustomFieldValues(fields, { [`id-${type}`]: value }), new RegExp(type));
});

test('hydration and duplication copy values without mutating the original; reset is empty', () => {
  const source = { 'id-number': 0, 'id-boolean': false, 'id-text': 'old' };
  const duplicate = copyCustomFieldValues(source);
  duplicate['id-text'] = 'new';
  assert.equal(source['id-text'], 'old');
  assert.deepEqual(copyCustomFieldValues(null), {});
  assert.deepEqual(copyCustomFieldValues([]), {});
});

test('definition rename preserves identity, new fields omit IDs and deletion does not reassign values', () => {
  const result = buildCustomFieldDefinitions([
    { id: 'saved-id', name: ' Renamed field ', type: 'text', choices: [], show_on_detail: true },
    { _key: 'draft-only', name: 'New field', type: 'select', choices: [' One ', 'Two'], show_on_detail: false },
  ]);
  assert.equal(result[0].id, 'saved-id');
  assert.equal(result[0].name, 'Renamed field');
  assert.equal(Object.hasOwn(result[1], 'id'), false);
  assert.equal(Object.hasOwn(result[1], '_key'), false);
  assert.deepEqual(result[1].choices, ['One', 'Two']);
  assert.deepEqual(buildCustomFieldValues([{ id: 'new-id', type: 'text', name: 'Same name' }], { 'saved-id': 'old value' }), {});
});

test('definition errors keep draft input untouched', () => {
  const draft = [{ name: 'Dropdown', type: 'select', choices: ['Duplicate', 'Duplicate'] }];
  assert.throws(() => buildCustomFieldDefinitions(draft), /unique/);
  assert.deepEqual(draft[0].choices, ['Duplicate', 'Duplicate']);
  assert.throws(() => buildCustomFieldDefinitions([{ name: ' ', type: 'text', choices: [] }]), /name/);
});

test('display omits blanks but retains zero and false with human-readable boolean labels', () => {
  const result = populatedCustomFieldDisplay([
    { id: 'zero', value: 0 }, { id: 'no', value: false }, { value: '' }, { value: '  ' }, { value: null }, { value: {} },
  ]);
  assert.deepEqual(result.map((field) => field.id), ['zero', 'no']);
  assert.equal(formatCustomFieldValue(false), 'No');
  assert.equal(formatCustomFieldValue(true), 'Yes');
  assert.equal(formatCustomFieldValue(0), '0');
});
