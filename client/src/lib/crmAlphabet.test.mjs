import test from 'node:test';
import assert from 'node:assert/strict';
import { alphabetTargetPage, crmListParams, groupAlphabetBuckets } from './crmAlphabet.mjs';

function buckets(entries) {
  let offset = 0;
  return entries.map(([label, count]) => {
    const bucket = { label, count, offset, id: `row-${offset}` };
    offset += count;
    return bucket;
  });
}

test('greedy groups respect actual 20/50 page sizes, exact totals, gaps and oversized runs', () => {
  const data = buckets([['A', 8], ['B', 12], ['C', 1], ['E', 2], ['F', 24], ['G', 1]]);
  assert.deepEqual(groupAlphabetBuckets(data, 20).map(g => [g.label, g.count, g.offset]),
    [['A–B', 20, 0], ['C', 1, 20], ['E', 2, 21], ['F', 24, 23], ['G', 1, 47]]);
  assert.deepEqual(groupAlphabetBuckets(data, 50).map(g => g.label), ['A–C', 'E–G']);
});

test('database run order is authoritative for repeated, accented and nonletter labels', () => {
  const data = buckets([['#', 3], ['A', 1], ['Á', 1], ['A', 1], ['B', 1], ['(blank)', 1], ['a', 1]]);
  const groups = groupAlphabetBuckets(data, 20);
  assert.deepEqual(groups.map(g => g.label), ['#', 'A', 'Á', 'A–B', '(blank)', 'a']);
  assert.equal(new Set(groups.map(g => g.key)).size, groups.length);
  assert.equal(groups[3].id, 'row-5');
  assert.equal(groups[3].offset, 5);
  assert.deepEqual(data.map(g => g.label), ['#', 'A', 'Á', 'A', 'B', '(blank)', 'a']);
});

test('offset discontinuities are never grouped, even for adjacent letters', () => {
  const data = [{ label: 'A', count: 1, offset: 7, id: 'a' }, { label: 'B', count: 1, offset: 12, id: 'b' }];
  assert.equal(groupAlphabetBuckets(data, 20).length, 2);
});

test('invalid targets are omitted and page mapping uses zero-based server offsets', () => {
  assert.deepEqual(groupAlphabetBuckets([null, { label: 'A', count: 1, offset: 0 }], 20), []);
  assert.deepEqual([0, 19, 20, 39, 40, 1112].map(offset => alphabetTargetPage(offset, 20)), [1, 1, 2, 2, 3, 56]);
  assert.equal(alphabetTargetPage(50, 50), 2);
});

test('wire params omit empty filters without discarding false or zero values', () => {
  assert.deepEqual(crmListParams({ search: '', coreFilters: '', customFilters: '{}', sortField: 'name', flag: false, zero: 0 }),
    { search: '', sortField: 'name', flag: false, zero: 0 });
});
