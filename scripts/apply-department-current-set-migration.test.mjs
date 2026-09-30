import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const script = await readFile(new URL('./apply-department-current-set-migration.mjs', import.meta.url), 'utf8');
const execFile = promisify(execFileCallback);

test('migration runner is pinned, SHA-reviewed, and uses verified TLS', () => {
  assert.match(script, /--review-sha256/);
  assert.match(script, /Reviewed migration SHA-256 is missing/);
  assert.match(script, /lvmzliemqnieeoruhkik\.supabase\.co/);
  assert.match(script, /aws-1-eu-central-1\.pooler\.supabase\.com/);
  assert.match(script, /db\.lvmzliemqnieeoruhkik\.supabase\.co/);
  assert.match(script, /Shared pool username is not pinned/);
  assert.match(script, /DESTINATION_CA_URL/);
  assert.match(script, /ca, servername/);
  assert.match(script, /rejectUnauthorized: true/);
  assert.match(script, /BEGIN/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /20261101_department_current_set\.sql/);
  assert.match(script, /20261102_department_current_set_auth\.sql/);
  assert.match(script, /20261103_department_current_set_direct_workforce\.sql/);
  assert.match(script, /20261104_department_current_set_department_organisation_auth\.sql/);
  assert.match(script, /20261105_department_current_set_assignment_auth\.sql/);
  assert.match(script, /20261106_department_current_set_survey_stamp\.sql/);
  assert.match(script, /direct-workforce config-v2/);
  assert.match(script, /Department-organisation authorization migration/);
  assert.match(script, /Installed current-set function contract drifted/);
  assert.match(script, /expectedSources\.get\(row\.contract\)\?\.includes\(row\.source\)/);
  assert.match(script, /has_function_privilege\('service_role'/);
  assert.match(script, /has_function_privilege\('authenticated'/);
  assert.match(script, /c5dcd16c-e63e-49f2-b72f-b0caaa7c5903/);
  assert.match(script, /field\.field_type = 'date'/);
  assert.match(script, /config\.config->>'department_object_id'/);
  assert.match(script, /before migration SQL/);
  assert.match(script, /for \(const migration of migrations\) await client\.query\(migration\.sql\)/);
});

test('installer dry run loads all backend files including assignment-only authorization and reports a ready reviewed bundle', async () => {
  const files = [
    '20261101_department_current_set.sql',
    '20261102_department_current_set_auth.sql',
    '20261103_department_current_set_direct_workforce.sql',
    '20261104_department_current_set_department_organisation_auth.sql',
    '20261105_department_current_set_assignment_auth.sql',
    '20261106_department_current_set_survey_stamp.sql',
  ];
  const sql = await Promise.all(files.map(file =>
    readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')));
  const expectedSha = createHash('sha256')
    .update(files.map((file, index) => `${file}\n${sql[index]}`).join('\n-- next migration --\n'))
    .digest('hex');
  const { stdout, stderr } = await execFile(process.execPath,
    [new URL('./apply-department-current-set-migration.mjs', import.meta.url).pathname]);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.deepEqual(report.migrations, files.map(file => `supabase/migrations/${file}`));
  assert.equal(report.directWorkforceMigration,
    'supabase/migrations/20261103_department_current_set_direct_workforce.sql');
  assert.equal(report.departmentOrganisationAuthMigration,
    'supabase/migrations/20261104_department_current_set_department_organisation_auth.sql');
  assert.equal(report.assignmentAuthMigration,
    'supabase/migrations/20261105_department_current_set_assignment_auth.sql');
  assert.equal(report.surveyStampMigration,
    'supabase/migrations/20261106_department_current_set_survey_stamp.sql');
  assert.equal(report.rolloutReadiness, 'ready-for-reviewed-apply');
  assert.equal(report.sha256, expectedSha);
  assert.equal(report.writesPerformed, false);
});