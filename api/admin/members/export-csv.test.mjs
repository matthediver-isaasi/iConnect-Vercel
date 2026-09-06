import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  formatCustomFieldValueForCsv,
  loadMemberPreferenceValuesForCsv,
} from './export-csv.js';

const source = fs.readFileSync(new URL('./export-csv.js', import.meta.url), 'utf8');

test('member CSV formats boolean and checkbox custom fields like member details', () => {
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

test('member CSV preserves existing non-boolean custom-field formatting', () => {
  assert.equal(formatCustomFieldValueForCsv(undefined, { field_type: 'text' }), '');
  assert.equal(formatCustomFieldValueForCsv('hello', { field_type: 'text' }), 'hello');
  assert.equal(formatCustomFieldValueForCsv('["A","B"]', { field_type: 'text' }), 'A, B');
  assert.equal(formatCustomFieldValueForCsv('a', {
    field_type: 'dropdown',
    options: [{ value: 'a', label: 'Alpha' }],
  }), 'Alpha');
});

test('member CSV preference pagination uses a stable unique order', () => {
  const calls = [];
  const pages = [
    [
      { id: '1', member_id: 'member-1', field_id: 'direct-debit', value: 'true' },
      { id: '2', member_id: 'member-1', field_id: 'other', value: 'text' },
    ],
    [
      { id: '3', member_id: 'member-2', field_id: 'direct-debit', value: 'false' },
    ],
  ];
  const client = {
    from(table) {
      const call = { table, filters: [], order: null, range: null };
      calls.push(call);
      const chain = {
        select(columns) { call.columns = columns; return chain; },
        in(column, values) { call.filters.push([column, values]); return chain; },
        order(column, options) { call.order = [column, options]; return chain; },
        range(from, to) {
          call.range = [from, to];
          return Promise.resolve({ data: pages[calls.length - 1] || [], error: null });
        },
      };
      return chain;
    },
  };

  return loadMemberPreferenceValuesForCsv(
    client,
    ['member-1', 'member-2'],
    ['direct-debit', 'other'],
    { pageSize: 2 },
  ).then(result => {
    assert.deepEqual(result, {
      'member-1': { 'direct-debit': 'true', other: 'text' },
      'member-2': { 'direct-debit': 'false' },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.range), [[0, 1], [2, 3]]);
    assert.deepEqual(calls.map(call => call.order), [
      ['id', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    assert.deepEqual(calls[0].filters, [
      ['member_id', ['member-1', 'member-2']],
      ['field_id', ['direct-debit', 'other']],
    ]);
  });
});

test('selected and filtered exports share the same custom-field row formatter', () => {
  assert.equal((source.match(/const customValues = customFields\.map/g) || []).length, 1);
  assert.match(source, /return formatCustomFieldValueForCsv\(rawValue, f\)/);
});