import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const runnerUrl = new URL('./apply-form-applicant-continuation-detachment.mjs', import.meta.url);
const migrationPath = 'migrations/20260925_form_applicant_continuation_organization_detachment.sql';
const migrationUrl = new URL(`../${migrationPath}`, import.meta.url);

test('task 4766 runner is checksum-reviewed, destination-only, transactional, and verifies postconditions', async () => {
  const runner = await readFile(runnerUrl, 'utf8');
  assert.match(runner, /destinationTarget\(env\)/);
  assert.match(runner, /lvmzliemqnieeoruhkik/);
  assert.doesNotMatch(runner, /SOURCE_DATABASE_URL/);
  assert.match(runner, /rejectUnauthorized: true/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /ROLLBACK/);
  assert.match(runner, /pg_advisory_xact_lock/);
  assert.match(runner, /organization_delete_set_null/);
  assert.match(runner, /continuation_rejects_null/);
  assert.match(runner, /draft_rejects_null/);
});

test('task 4766 runner defaults to an offline exact-file checksum without writes', async () => {
  const migration = await readFile(migrationUrl, 'utf8');
  const expected = createHash('sha256').update(`${migrationPath}\n${migration}`).digest('hex');
  const { stdout, stderr } = await execFile(process.execPath, [runnerUrl.pathname]);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), {
    dryRun: true,
    destinationProject: 'lvmzliemqnieeoruhkik',
    migration: migrationPath,
    sha256: expected,
    writesPerformed: false,
  });
});