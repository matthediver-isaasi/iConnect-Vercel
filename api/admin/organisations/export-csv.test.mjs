import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCustomFieldValueForCsv } from './export-csv.js';

test('organisation CSV formats boolean and checkbox custom fields like organisation details', () => {
  for (const fieldType of ['boolean', 'checkbox']) {
    const field = { field_type: fieldType };
    assert.equal(formatCustomFieldValueForCsv(true, field), 'Yes');
    assert.equal(formatCustomFieldValueForCsv('true', field), 'Yes');
    assert.equal(formatCustomFieldValueForCsv(false, field), 'No');
    assert.equal(formatCustomFieldValueForCsv('false', field), 'No');
    assert.equal(formatCustomFieldValueForCsv(undefined, field), 'No');
    assert.equal(formatCustomFieldValueForCsv(null, field), 'No');
  }
});

test('organisation CSV preserves existing non-boolean custom-field formatting', () => {
  assert.equal(formatCustomFieldValueForCsv(undefined, { field_type: 'text' }), '');
  assert.equal(formatCustomFieldValueForCsv('hello', { field_type: 'text' }), 'hello');
  assert.equal(formatCustomFieldValueForCsv(['A', 'B'], { field_type: 'text' }), 'A, B');
  assert.equal(formatCustomFieldValueForCsv('a', {
    field_type: 'dropdown',
    options: [{ value: 'a', label: 'Alpha' }],
  }), 'Alpha');
});