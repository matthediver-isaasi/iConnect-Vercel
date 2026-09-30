/**
 * Tests for the scheduled-backup cron loop helpers in backupRunner.js:
 *  - isSameUtcDay (per-UTC-day early-exit comparison)
 *  - runStorageBackupToCompletion (multi-chunk loop, deadline stop, error stop)
 *  - runDatabaseBackupToCompletion (multi-chunk loop, no-progress error stop)
 *
 * Chunk runners are injected stubs — no Supabase/R2/Postgres access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSameUtcDay,
  runStorageBackupToCompletion,
  runDatabaseBackupToCompletion,
} from './backupRunner.js';

test('isSameUtcDay', () => {
  assert.equal(isSameUtcDay('2026-07-20T02:00:00Z', '2026-07-20T23:59:59Z'), true);
  assert.equal(isSameUtcDay('2026-07-19T23:59:59Z', '2026-07-20T00:00:01Z'), false);
  assert.equal(isSameUtcDay(null, '2026-07-20T00:00:01Z'), false);
  assert.equal(isSameUtcDay('not-a-date', '2026-07-20T00:00:01Z'), false);
});

test('storage loop runs chunks until sweep completes and aggregates totals', async () => {
  const chunks = [
    { ok: true, copied: 5, skipped: 10, errored: 0, bytes: 100, deferred: true },
    { ok: true, copied: 3, skipped: 2, errored: 1, bytes: 50, deferred: true },
    { ok: true, copied: 1, skipped: 0, errored: 0, bytes: 10, deferred: false },
  ];
  let calls = 0;
  const result = await runStorageBackupToCompletion({
    deadline: Date.now() + 60_000,
    runChunk: async () => chunks[calls++],
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, true);
  assert.equal(result.deferred, false);
  assert.deepEqual(
    { copied: result.copied, skipped: result.skipped, errored: result.errored, bytes: result.bytes, chunks: result.chunks },
    { copied: 9, skipped: 12, errored: 1, bytes: 160, chunks: 3 }
  );
});

test('storage loop stops at the deadline and reports deferred', async () => {
  let calls = 0;
  const result = await runStorageBackupToCompletion({
    deadline: Date.now() + 5_000, // below MIN_CHUNK_MS => no chunk should run
    runChunk: async () => {
      calls++;
      return { ok: true, deferred: true };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.deferred, true);
  assert.equal(result.ok, true);
});

test('storage loop caps chunk budget at remaining time', async () => {
  let seenBudget = null;
  await runStorageBackupToCompletion({
    deadline: Date.now() + 20_000,
    chunkBudgetMs: 50_000,
    runChunk: async ({ timeBudgetMs }) => {
      seenBudget = timeBudgetMs;
      return { ok: true, deferred: false };
    },
  });
  assert.ok(seenBudget <= 20_000, `budget ${seenBudget} should be capped at remaining time`);
});

test('storage loop stops on a failed chunk and surfaces the error', async () => {
  let calls = 0;
  const result = await runStorageBackupToCompletion({
    deadline: Date.now() + 60_000,
    runChunk: async () => {
      calls++;
      return { ok: false, error: 'boom', deferred: true };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
});

test('database loop resumes across chunks until complete', async () => {
  const chunks = [
    { ok: true, complete: false, runStamp: 'S', totalTables: 10, dumped: [{}, {}, {}], skipped: ['a', 'b'], errored: [], totalCompressedBytes: 100 },
    { ok: true, complete: true, runStamp: 'S', totalTables: 10, dumped: [{}, {}], skipped: [], errored: [], totalCompressedBytes: 40 },
  ];
  let calls = 0;
  const result = await runDatabaseBackupToCompletion({
    deadline: Date.now() + 60_000,
    runChunk: async () => chunks[calls++],
  });
  assert.equal(calls, 2);
  assert.equal(result.complete, true);
  assert.equal(result.ok, true);
  assert.equal(result.dumped, 5);
  assert.equal(result.totalCompressedBytes, 140);
  assert.equal(result.runStamp, 'S');
});

test('database loop does not retry-spin when tables errored with nothing deferred', async () => {
  let calls = 0;
  const result = await runDatabaseBackupToCompletion({
    deadline: Date.now() + 600_000,
    runChunk: async () => {
      calls++;
      return { ok: true, complete: false, totalTables: 3, dumped: [{}], skipped: [], errored: [{ table: 'x', error: 'perm' }], totalCompressedBytes: 5 };
    },
  });
  assert.equal(calls, 1, 'must stop after one no-progress chunk');
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.erroredTables.length, 1);
});

test('database loop stops when remaining time is below the minimum chunk', async () => {
  let calls = 0;
  const result = await runDatabaseBackupToCompletion({
    deadline: Date.now() + 1_000,
    runChunk: async () => {
      calls++;
      return { ok: true, complete: true, dumped: [], skipped: [], errored: [] };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.complete, false);
});
