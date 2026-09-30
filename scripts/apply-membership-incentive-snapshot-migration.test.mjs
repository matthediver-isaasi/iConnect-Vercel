import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const runner = 'scripts/apply-membership-incentive-snapshot-migration.mjs';
const file = 'supabase/migrations/20261116_membership_incentive_snapshot.sql';
const invoke = (args = [], env = {}) => spawnSync(process.execPath, [runner, ...args], {
  encoding: 'utf8', env: { PATH: process.env.PATH, DEST_DATABASE_URL: '', DEST_SUPABASE_URL: '',
    DEST_DATABASE_CA_FILE: '', DATABASE_URL: '', ...env },
});
test('incentive migration runner dry run binds review to exact file identity and content; no credentials or network', () => {
  const output = invoke();
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.writesPerformed, false);
  assert.equal(result.sha256, createHash('sha256').update(JSON.stringify({ file, sql: readFileSync(file, 'utf8') })).digest('hex'));
});
test('incentive migration apply rejects absent review, wrong destination and absent reviewed CA before any connection', () => {
  assert.match(invoke(['--apply']).stderr, /Reviewed migration hash required/);
  const { sha256 } = JSON.parse(invoke().stdout);
  const args = ['--apply', `--review-sha256=${sha256}`];
  assert.match(invoke(args).stderr, /Destination pin mismatch/);
  assert.match(invoke(args, { DEST_DATABASE_URL: 'postgres://postgres@wrong.invalid/postgres',
    DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co' }).stderr, /Destination pin mismatch/);
  assert.match(invoke(args, { DEST_DATABASE_URL: 'postgres://postgres@db.lvmzliemqnieeoruhkik.supabase.co/postgres',
    DEST_SUPABASE_URL: 'https://lvmzliemqnieeoruhkik.supabase.co' }).stderr, /Reviewed destination CA file required/);
  const source = readFileSync(runner, 'utf8');
  assert.match(source, /rejectUnauthorized: true/);
  assert.match(source, /ROLLBACK/);
  assert.doesNotMatch(source, /fetch\(|process\.env\.DATABASE_URL/);
  const sql = readFileSync(file, 'utf8');
  assert.match(sql, /NEW\.incentive_snapshot IS DISTINCT FROM OLD\.incentive_snapshot/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.protect_membership_incentive_snapshot\(\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY|GRANT .* TO (?:anon|authenticated|PUBLIC)|SECURITY DEFINER/i);
});