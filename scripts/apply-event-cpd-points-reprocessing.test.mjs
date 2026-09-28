import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const runner = 'scripts/apply-event-cpd-points-reprocessing.mjs';
const migration = 'supabase/migrations/20261123_event_cpd_points_safe_reprocessing.sql';
const invoke = (args = [], env = {}) => spawnSync(process.execPath, [runner, ...args], {
  encoding: 'utf8', env: {
    PATH: process.env.PATH, DEST_DATABASE_URL: '', DEST_SUPABASE_URL: '', DATABASE_URL: '', ...env,
  },
});
test('reprocessing installer defaults to offline hash-only dry run', () => {
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.writesPerformed, false);
  assert.equal(output.destinationProject, 'lvmzliemqnieeoruhkik');
  assert.equal(output.sha256, createHash('sha256').update(`${migration}\n${readFileSync(migration, 'utf8')}`).digest('hex'));
});
test('reprocessing installer fails closed on review and destination identity', () => {
  assert.notEqual(invoke(['--apply']).status, 0);
  assert.notEqual(invoke(['--apply', '--preflight']).status, 0);
  const { sha256 } = JSON.parse(invoke().stdout);
  const args = ['--apply', `--review-sha256=${sha256}`];
  assert.match(invoke(args, { DATABASE_URL: 'postgres://legacy.example/postgres' }).stderr, /Pinned destination credentials unavailable/);
  assert.match(invoke(['--preflight']).stderr, /Pinned destination credentials unavailable/);
  assert.match(invoke(args, {
    DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
    DEST_DATABASE_URL: 'postgres://postgres:password@legacy.example:5432/postgres',
  }).stderr, /identity pin mismatch/);
  const source = readFileSync(runner, 'utf8');
  assert.match(source, /rejectUnauthorized: true/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /ROLLBACK/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
});