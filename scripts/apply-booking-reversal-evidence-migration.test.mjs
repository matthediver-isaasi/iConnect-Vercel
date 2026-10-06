import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const runnerUrl = new URL('./apply-booking-reversal-evidence-migration.mjs', import.meta.url);
const migrationUrl = new URL('../migrations/20260720_booking_reversal_evidence.sql', import.meta.url);
const [runner, migration] = await Promise.all([
  readFile(runnerUrl, 'utf8'),
  readFile(migrationUrl, 'utf8'),
]);

test('booking reversal installer is destination-pinned, reviewed, transactional, and verifies schema', () => {
  assert.match(runner, /DEST_DATABASE_URL/);
  assert.doesNotMatch(runner, /SOURCE_DATABASE_URL/);
  assert.match(runner, /lvmzliemqnieeoruhkik/);
  assert.match(runner, /aws-1-eu-central-1\.pooler\.supabase\.com/);
  assert.match(runner, /Shared pool username is not pinned/);
  assert.match(runner, /rejectUnauthorized: true/);
  assert.match(runner, /ca, servername/);
  assert.match(runner, /Reviewed migration SHA-256 is missing/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /ROLLBACK/);
  assert.match(runner, /pg_advisory_xact_lock/);
  assert.match(runner, /columns_exact/);
  assert.match(runner, /seven_check_constraints/);
  assert.match(runner, /rls_enabled/);
  assert.match(runner, /service_role_crud/);
  assert.match(runner, /transaction rolled back/);
});

test('dry run hashes the exact migration and performs no writes', async () => {
  const expectedSha = createHash('sha256')
    .update(`migrations/20260720_booking_reversal_evidence.sql\n${migration}`)
    .digest('hex');
  const { stdout, stderr } = await execFile(process.execPath, [runnerUrl.pathname]);
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.dryRun, true);
  assert.equal(result.destinationProject, 'lvmzliemqnieeoruhkik');
  assert.equal(result.migration, 'migrations/20260720_booking_reversal_evidence.sql');
  assert.equal(result.sha256, expectedSha);
  assert.equal(result.writesPerformed, false);
});

test('verification migration is separately hashed, access restricted and remains dry-run by default', async () => {
  const path = 'migrations/20260722_booking_credit_verification.sql';
  const sql = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const { stdout } = await execFile(process.execPath, [runnerUrl.pathname, '--verification']);
  const result = JSON.parse(stdout);
  assert.equal(result.migration, path);
  assert.equal(result.writesPerformed, false);
  assert.equal(result.sha256, createHash('sha256').update(`${path}\n${sql}`).digest('hex'));
  assert.match(sql, /UNIQUE \(tenant_id, booking_source, booking_id\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL[\s\S]*FROM anon, authenticated/);
  assert.match(sql, /verified_at IS NOT NULL/);
  assert.match(sql, /"allApplicableScopes":true,"paginationComplete":true/);
  await assert.rejects(execFile(process.execPath, [
    runnerUrl.pathname, '--verification', '--apply', '--review-sha256=wrong',
  ]), /SHA-256 is missing or does not match/);
});