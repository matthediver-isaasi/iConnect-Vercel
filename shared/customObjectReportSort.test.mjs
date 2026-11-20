import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReportSort, reportDefinitionKey, reportSortValue } from './customObjectReportSort.mjs';
test('sorting is optional, validates stable identities and preserves priority', () => {
  const report = { columns: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(validateReportSort(report), []);
  assert.deepEqual(validateReportSort({ ...report, sort: [{ column_id: 'b', direction: 'desc' }, { column_id: 'a', direction: 'asc' }] })
    .map(r => r.index), [1, 0]);
  for (const sort of [null, {}, [null], [{ column_id: 'a', direction: 'DESC' }], [{ column_id: 'missing', direction: 'asc' }],
    Array.from({ length: 11 }, () => ({ column_id: 'a', direction: 'asc' })),
    [{ column_id: 'a', direction: 'asc' }, { column_id: 'a', direction: 'desc' }]]) {
    assert.throws(() => validateReportSort({ ...report, sort }));
  }
  assert.throws(() => validateReportSort({ columns: [{ id: 'a' }, { id: 'a' }], sort: [{ column_id: 'a', direction: 'asc' }] }));
});
test('definition identity is independent of JSONB property order but includes ordered sort priority', () => {
  assert.equal(reportDefinitionKey({ b: 1, a: { z: true, x: 0 } }), reportDefinitionKey({ a: { x: 0, z: true }, b: 1 }));
  assert.notEqual(reportDefinitionKey({ sort: [1, 2] }), reportDefinitionKey({ sort: [2, 1] }));
});
test('typed scalar keys preserve false/zero and omit only blank/null; joined values sort as displayed', () => {
  assert.equal(reportSortValue([false], 'No'), false);
  assert.equal(reportSortValue([0], '0'), 0);
  assert.equal(reportSortValue([128], '128'), 128);
  assert.equal(reportSortValue(['2026-01-01'], '2026-01-01'), '2026-01-01');
  assert.equal(reportSortValue([undefined, null, ''], ''), null);
  assert.equal(reportSortValue([2, 10], '2; 10'), '2; 10');
});
