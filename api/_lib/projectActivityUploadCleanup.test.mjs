import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupProjectActivityUploads } from './projectActivityUploadCleanup.js';

function fixture({ failRead = false, failStorage = false } = {}) {
  const deleted = [], removed = [];
  const uploads = [{ id: 'confirmed', storage_path: 'confirmed.png' }, { id: 'orphan', storage_path: 'orphan.png' }];
  const db = {
    from(table) {
      let id, deleting = false;
      const q = {
        select() { return q; }, lt() { return q; }, order() { return q; }, limit(n) { assert.equal(n, 100); return q; },
        eq(k, v) { id = v; return q; }, maybeSingle() { return q; }, delete() { deleting = true; return q; },
        then(resolve) {
          if (deleting) deleted.push(id);
          return Promise.resolve({ data: table === 'project_activity_upload' ? uploads : id === 'confirmed' ? { id } : null,
            error: failRead && table === 'project_card_attachment' ? new Error('read failed') : null }).then(resolve);
        },
      };
      return q;
    },
    storage: { from(bucket) { assert.equal(bucket, 'file-repository'); return {
      async remove(paths) { removed.push(...paths); return { error: failStorage ? new Error('storage failed') : null }; },
    }; } },
  };
  return { db, removed, deleted };
}
test('orphan cleanup preserves confirmed/shared attachments and removes only expired unconfirmed files', async () => {
  const f = fixture();
  assert.deepEqual(await cleanupProjectActivityUploads(f.db), { processed: 2, removed: 1 });
  assert.deepEqual(f.removed, ['orphan.png']);
  assert.deepEqual(f.deleted, ['confirmed', 'orphan']);
});
test('read and storage failures retain unconfirmed cleanup records for retry', async () => {
  for (const options of [{ failRead: true }, { failStorage: true }]) {
    const f = fixture(options);
    await assert.rejects(cleanupProjectActivityUploads(f.db));
    assert.ok(!f.deleted.includes('orphan'));
    if (options.failRead) assert.deepEqual(f.removed, []);
  }
});
