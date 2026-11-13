import test from 'node:test';
import assert from 'node:assert/strict';
import { readAudienceListPage } from './audienceListPages.js';

function fixture() {
  const calls = [];
  const query = {};
  for (const method of ['select', 'eq', 'filter', 'order', 'range']) {
    query[method] = (...args) => { calls.push([method, ...args]); return query; };
  }
  query.then = resolve => Promise.resolve({ data: [{ id: 'row' }], count: 1045, error: null }).then(resolve);
  return { calls, db: { from: table => { calls.push(['from', table]); return query; } } };
}

test('pagination is tenant scoped, stable and uses exact totals beyond the first 1000 rows', async () => {
  const { calls, db } = fixture();
  const result = await readAudienceListPage(db, 'tenant', { page: '42', pageSize: '25' });
  assert.equal(result.total, 1045);
  assert.deepEqual(calls, [
    ['from', 'audience_list'], ['select', '*', { count: 'exact' }], ['eq', 'tenant_id', 'tenant'],
    ['order', 'name'], ['order', 'id'], ['range', 1025, 1049],
  ]);
});

test('search treats punctuation and wildcard-like characters literally', async () => {
  const { calls, db } = fixture();
  await readAudienceListPage(db, 'tenant', { search: ' List (A)* 50%_ ' });
  assert.deepEqual(calls.find(call => call[0] === 'filter'),
    ['filter', 'name', 'imatch', 'List \\(A\\)\\* 50%_']);
});

test('invalid paging and search inputs fail before querying', async () => {
  for (const params of [{ page: '0' }, { page: '1.5' }, { pageSize: '10000' }, { search: ['bad'] }, { search: 'a'.repeat(201) }]) {
    const { db, calls } = fixture();
    await assert.rejects(readAudienceListPage(db, 'tenant', params), error => error.status === 400);
    assert.equal(calls.length, 0);
  }
});
