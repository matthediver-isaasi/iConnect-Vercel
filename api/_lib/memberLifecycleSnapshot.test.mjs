import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleStableDetail } from './memberLifecycleSnapshot.js';
const a = 'a'.repeat(32), b = 'b'.repeat(32);
test('fresh detail is bound to the same source generation before and after reading', async () => {
  const db = { rpc: async () => ({ data: a }) };
  const detail = await lifecycleStableDetail(db, 'tenant', 'member', {}, { detail: async () => ({ revision: 1 }) });
  assert.deepEqual(detail, { revision: 1, sourceStamp: a });
});
test('changed sources retry only reads and never authorize a stale decision', async () => {
  const stamps = [a,b,b,b]; let reads = 0;
  const result = await lifecycleStableDetail({ rpc: async () => ({ data: stamps.shift() }) }, 't','m',{}, {
    detail: async () => ({ revision: ++reads }),
  });
  assert.equal(result.revision, 2);
  let count = 0;
  await assert.rejects(lifecycleStableDetail({ rpc: async () => ({ data: ++count % 2 ? a : b }) }, 't','m',{}, {
    detail: async () => ({}),
  }), error => error.status === 409);
});
