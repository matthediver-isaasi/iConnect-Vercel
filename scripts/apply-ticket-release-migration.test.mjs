import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { main, MIGRATION } from './apply-ticket-release-migration.mjs';

test('migration is nullable and backward compatible without ticket data updates', async () => {
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS release_at timestamptz/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS release_timezone text/);
  assert.match(sql, /release_at IS NULL AND release_timezone IS NULL/);
  assert.match(sql, /isfinite\(release_at\)/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|INSERT|DROP)\b/);
});

test('offline review never connects and apply requires exact hash and pinned destination', async () => {
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const logs = [];
  const original = console.log;
  console.log = value => logs.push(JSON.parse(value));
  try {
    await main([], {});
  } finally {
    console.log = original;
  }
  assert.deepEqual(logs, [{ migration: MIGRATION, sha256, dryRun: true, writesPerformed: false }]);
  await assert.rejects(main(['--apply'], {}), /Reviewed migration hash/);
  await assert.rejects(main(['--apply', `--review-sha256=${'0'.repeat(64)}`], {}), /Reviewed migration hash/);
  await assert.rejects(main(['--apply', `--review-sha256=${sha256}`], {}), /Pinned destination/);
  await assert.rejects(main(['--source'], {}), /Only --apply/);
});