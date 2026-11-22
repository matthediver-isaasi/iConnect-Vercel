import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReportViewerQuery, matchesReportViewerQuery as matches } from './reportViewerQuery.mjs';
const query = input => normalizeReportViewerQuery(input, 3);
test('search uses literal case-insensitive displayed values and combines field filters with AND', () => {
  assert.equal(matches(['Imaging', 'London', 12], query({ search: 'LONDON' })), true);
  assert.equal(matches(['Imaging', 'London', 12], query({ search: '%' })), false);
  assert.equal(matches(['100%_special*', '', false], query({ search: '%_special*' })), true);
  const filters = [{ column: 0, operator: 'starts_with', value: ' ima ' }, { column: 1, operator: 'equals', value: 'London' }];
  assert.equal(matches(['Imaging', 'LONDON', 0], query({ filters })), true);
  assert.equal(matches(['Imaging', 'Paris', 0], query({ filters })), false);
  assert.equal(matches(['Imaging', 'London', 0], query({ filters, search: 'Paris' })), false);
  for (const value of ['', null, '   ']) {
    assert.equal(matches([value, '', ''], query({ filters: [{ column: 0, operator: 'empty' }] })), true);
  }
  assert.equal(matches([false, '', ''], query({ filters: [{ column: 0, operator: 'not_empty' }] })), true);
  assert.equal(matches([0, '', ''], query({ filters: [{ column: 0, operator: 'not_equals', value: '1' }] })), true);
});
test('query validation rejects hidden columns, unbounded inputs and operator injection', () => {
  assert.deepEqual(query(undefined), { search: '', filters: [] });
  for (const input of ['text', [], { search: 42 }, { search: 'x'.repeat(201) }, { search: '\0' },
    { hidden_field: 'email' }, { filters: {} }, { filters: Array(21).fill({ column: 0, operator: 'empty' }) },
    { filters: [{ column: -1, operator: 'contains', value: 'x' }] },
    { filters: [{ column: 3, operator: 'contains', value: 'x' }] },
    { filters: [{ column: '0', operator: 'contains', value: 'x' }] },
    { filters: [{ column: 0, operator: 'sql', value: 'x' }] },
    { filters: [{ column: 0, operator: 'contains', value: ' ' }] },
    { filters: [{ column: 0, operator: 'equals', value: { password: 'x' } }] }]) {
    assert.throws(() => query(input), /Invalid/);
  }
});
