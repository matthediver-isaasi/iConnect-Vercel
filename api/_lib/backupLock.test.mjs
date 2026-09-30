/**
 * Unit tests for the best-effort backup lease lock (acquireBackupLock /
 * releaseBackupLock in backupRunner.js) using injected load/save deps —
 * no R2 access required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireBackupLock,
  releaseBackupLock,
  STORAGE_LOCK_KEY,
  DB_LOCK_KEY,
  DEFAULT_LOCK_TTL_MS,
} from './backupRunner.js';

function memoryStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    deps: {
      load: async (key) => (store.has(key) ? store.get(key) : null),
      save: async (key, value) => { store.set(key, value); },
    },
  };
}

test('acquires the lock when no lock object exists', async () => {
  const { store, deps } = memoryStore();
  const res = await acquireBackupLock('storage', { holder: 'cron', deps });
  assert.equal(res.acquired, true);
  assert.ok(res.token);
  const lock = store.get(STORAGE_LOCK_KEY);
  assert.equal(lock.token, res.token);
  assert.equal(lock.holder, 'cron');
});

test('second caller loses while a live lease is held', async () => {
  const { deps } = memoryStore();
  const first = await acquireBackupLock('database', { holder: 'cron', deps });
  assert.equal(first.acquired, true);
  const second = await acquireBackupLock('database', { holder: 'manual', deps });
  assert.equal(second.acquired, false);
  assert.equal(second.holder, 'cron');
  assert.ok(second.expiresAt);
});

test('expired lease can be taken over (crashed run never wedges backups)', async () => {
  const now = Date.now();
  const { deps } = memoryStore({
    [DB_LOCK_KEY]: {
      token: 'old-token',
      holder: 'cron',
      acquiredAt: new Date(now - 2 * DEFAULT_LOCK_TTL_MS).toISOString(),
      expiresAt: new Date(now - DEFAULT_LOCK_TTL_MS).toISOString(),
    },
  });
  const res = await acquireBackupLock('database', { holder: 'manual', now, deps });
  assert.equal(res.acquired, true);
  assert.ok(res.token);
});

test('released lock can be re-acquired', async () => {
  const { deps } = memoryStore();
  const first = await acquireBackupLock('storage', { holder: 'manual', deps });
  await releaseBackupLock('storage', first.token, { deps });
  const second = await acquireBackupLock('storage', { holder: 'cron', deps });
  assert.equal(second.acquired, true);
});

test('release is a no-op when the lease was taken over by another run', async () => {
  const { store, deps } = memoryStore();
  const stale = await acquireBackupLock('storage', { holder: 'cron', deps });
  // Simulate takeover after TTL expiry.
  const takeover = await acquireBackupLock('storage', {
    holder: 'manual',
    now: Date.now() + DEFAULT_LOCK_TTL_MS + 1000,
    deps,
  });
  assert.equal(takeover.acquired, true);
  await releaseBackupLock('storage', stale.token, { deps });
  const lock = store.get(STORAGE_LOCK_KEY);
  assert.equal(lock.token, takeover.token, 'stale release must not clobber the new holder');
});

test('write-then-verify loses the race when another writer overwrote the lock', async () => {
  const { store } = memoryStore();
  const deps = {
    load: async (key) => (store.has(key) ? store.get(key) : null),
    save: async (key, value) => {
      // Simulate a near-simultaneous competitor winning the last write.
      store.set(key, { ...value, token: 'competitor-token', holder: 'cron' });
    },
  };
  const res = await acquireBackupLock('storage', { holder: 'manual', deps });
  assert.equal(res.acquired, false);
  assert.equal(res.holder, 'cron');
});

test('acquire fails open when the lock store errors', async () => {
  const deps = {
    load: async () => { throw new Error('R2 down'); },
    save: async () => { throw new Error('R2 down'); },
  };
  const res = await acquireBackupLock('database', { holder: 'cron', deps });
  assert.equal(res.acquired, true);
  assert.equal(res.token, null);
  assert.equal(res.degraded, true);
});
