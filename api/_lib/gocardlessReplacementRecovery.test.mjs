import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileMandateReplacements } from './gocardlessMandateReplacement.js';

function fixture(rows) {
  let clock = Date.now();
  const records = rows.map((r, i) => ({ tenant_id: 'tenant', version: 0,
    updated_at: new Date(i).toISOString(), ...r }));
  const db = { from() {
    const filters = []; let patch, max = 10;
    const matches = row => filters.every(f => f(row));
    const query = {
      select() { return this; },
      eq(k, v) { filters.push(row => row[k] === v); return this; },
      in(k, v) { filters.push(row => v.includes(row[k])); return this; },
      order() { return this; }, limit(n) { max = n; return this; },
      update(p) { patch = p; return this; },
      async maybeSingle() {
        const row = records.find(matches);
        if (!row) return { data: null };
        Object.assign(row, patch, { version: row.version + 1, updated_at: new Date(++clock).toISOString() });
        return { data: { ...row } };
      },
      then(resolve, reject) {
        return Promise.resolve({ data: records.filter(matches)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id))
          .slice(0, max).map(row => ({ ...row })) }).then(resolve, reject);
      },
    };
    return query;
  } };
  const visited = [];
  return { db, records, visited, clientForTenant: async () => ({}),
    refresh: async ({ operation }) => { visited.push(operation.id); return operation; }, limit: 1 };
}
test('an abandoned authorization cannot consume the recovery slot of a switching operation', async () => {
  const f = fixture([{ id: 'abandoned', status: 'authorizing' }, { id: 'handover', status: 'switching' }]);
  await reconcileMandateReplacements(f);
  assert.deepEqual(f.visited, ['handover']);
});
test('pending authorizations rotate even when the provider returns no changes', async () => {
  const f = fixture([{ id: 'abandoned', status: 'authorizing' }, { id: 'newer', status: 'awaiting_confirmation' }]);
  await reconcileMandateReplacements(f); await reconcileMandateReplacements(f);
  assert.deepEqual(f.visited, ['abandoned', 'newer']);
});
test('provider failure rotates the attempted switching operation rather than starving its sibling', async () => {
  const f = fixture([{ id: 'failing', status: 'switching' }, { id: 'recoverable', status: 'switching' }]);
  const refresh = f.refresh;
  f.refresh = async args => { await refresh(args); if (args.operation.id === 'failing') throw new Error('timeout'); };
  assert.equal((await reconcileMandateReplacements(f)).errors, 1);
  assert.equal((await reconcileMandateReplacements(f)).processed, 1);
  assert.deepEqual(f.visited, ['failing', 'recoverable']);
});
test('attempt timestamp changes do not alter the immutable handover settling timestamp', async () => {
  const snapshot = { prepared_at: '2026-01-01T00:00:00.000Z' };
  const f = fixture([{ id: 'settling', status: 'switching', phase: 'prepared', snapshot }]);
  await reconcileMandateReplacements(f);
  assert.equal(f.records[0].snapshot.prepared_at, snapshot.prepared_at);
  assert.notEqual(f.records[0].updated_at, snapshot.prepared_at);
});
