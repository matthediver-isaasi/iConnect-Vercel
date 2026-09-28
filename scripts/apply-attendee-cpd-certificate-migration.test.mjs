import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const runner = 'scripts/apply-attendee-cpd-certificate-migration.mjs';
const migration = 'supabase/migrations/20261120_attendee_cpd_certificate_delivery.sql';
const invoke = (args = [], env = {}) => spawnSync(process.execPath, [runner, ...args], {
  // Isolation propagates its boundary by merging parent environment variables.
  // Explicit empty values prevent ambient destination credentials being restored
  // to test cases that intentionally exercise missing credentials.
  encoding: 'utf8', env: {
    PATH: process.env.PATH, DEST_DATABASE_URL: '', DEST_SUPABASE_URL: '', DATABASE_URL: '', ...env,
  },
});
test('installer dry run hashes exact migration bytes without credentials or writes', () => {
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.writesPerformed, false);
  assert.equal(output.destinationProject, 'lvmzliemqnieeoruhkik');
  assert.equal(output.sha256, createHash('sha256').update(`${migration}\n${readFileSync(migration, 'utf8')}`).digest('hex'));
});
test('installer rejects missing review, legacy credentials and destination hostname mismatch before network access', () => {
  assert.notEqual(invoke(['--apply']).status, 0);
  const { sha256 } = JSON.parse(invoke().stdout);
  const args = ['--apply', `--review-sha256=${sha256}`];
  assert.match(invoke(args, { DATABASE_URL: 'postgres://legacy.example/postgres' }).stderr, /Pinned destination credentials unavailable/);
  assert.match(invoke(args, {
    DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co',
    DEST_DATABASE_URL: 'postgres://postgres:password@legacy.example:5432/postgres',
  }).stderr, /identity pin mismatch/);
  const source = readFileSync(runner, 'utf8');
  assert.match(source, /rejectUnauthorized: true/);
  assert.match(source, /columns_exact/);
  assert.match(source, /ROLLBACK/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
});