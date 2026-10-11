import test from 'node:test';
import assert from 'node:assert/strict';
import { listQuoteEventOptions } from './salesQuoteEventOptions.js';

function fixture(rows = {}, error = null) {
  const calls = [];
  return { calls, from(table) {
    const operations = []; calls.push({ table, operations });
    const chain = {};
    for (const method of ['select', 'eq', 'filter', 'or', 'order', 'range']) chain[method] = (...args) => { operations.push([method, ...args]); return chain; };
    chain.then = resolve => resolve({ data: rows[table] || [], error });
    return chain;
  } };
}
test('event lookup scopes both kinds, searches literally and filters past end dates before paging', async () => {
  const db = fixture({
    event: Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, title: `Workshop ${i}` })),
    complex_event: [{ id: 'b', title: 'Conference', start_date: '2026-10-20' }],
  });
  const result = await listQuoteEventOptions(db, 'tenant-only', { search: 'a.*', page: '2', excludePast: 'true' }, new Date('2026-10-11T12:00:00Z'));
  assert.equal(result.items.length, 26);
  assert.equal(result.hasMore, true);
  assert.equal(result.items.find(row => row.id === 'b').kind, 'complex');
  for (const call of db.calls) {
    assert.ok(call.operations.some(op => op[0] === 'eq' && op[1] === 'tenant_id' && op[2] === 'tenant-only'));
    assert.deepEqual(call.operations.find(op => op[0] === 'filter'), ['filter', 'title', 'imatch', 'a\\.\\*']);
    assert.deepEqual(call.operations.at(-1), ['range', 25, 50]);
    assert.match(call.operations.find(op => op[0] === 'or')[1], /end_date.gte.2026-10-11T12:00:00.000Z/);
  }
});
test('past selected events resolve independently without clearing the selection', async () => {
  const db = fixture();
  await listQuoteEventOptions(db, 'tenant', { selectedId: '11111111-1111-4111-8111-111111111111', kind: 'complex', excludePast: 'true' });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].table, 'complex_event');
  assert.equal(db.calls[0].operations.some(op => op[0] === 'or'), false);
  const all = fixture();
  await listQuoteEventOptions(all, 'tenant', { excludePast: 'false' });
  assert.ok(all.calls.every(call => !call.operations.some(op => op[0] === 'or')));
  await assert.rejects(() => listQuoteEventOptions(fixture({}, new Error('Database unavailable')), 'tenant'), /Database unavailable/);
  await assert.rejects(() => listQuoteEventOptions(fixture(), 'tenant', { selectedId: 'invalid', kind: 'simple' }), /Invalid selected event/);
});
