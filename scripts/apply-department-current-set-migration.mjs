#!/usr/bin/env node
/**
 * Reviewed, destination-pinned migration installer for task 4471.
 * It never writes unless --apply and the exact migration SHA-256 are supplied.
 *
 * Usage:
 *   node scripts/apply-department-current-set-migration.mjs
 *   node scripts/apply-department-current-set-migration.mjs --apply --review-sha256=<sha256>
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const FILES = [
  '20261101_department_current_set.sql',
  '20261102_department_current_set_auth.sql',
  '20261103_department_current_set_direct_workforce.sql',
  '20261104_department_current_set_department_organisation_auth.sql',
  '20261105_department_current_set_assignment_auth.sql',
];
const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const DESTINATION_PROJECT_SUFFIX = '.lvmzliemqnieeoruhkik';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const review = args.find(argument => argument.startsWith('--review-sha256='));
if (args.some(argument => argument !== '--apply' && !argument.startsWith('--review-sha256='))) {
  throw new Error('Supported arguments are --apply and --review-sha256=<sha256>.');
}
const migrations = await Promise.all(FILES.map(async file => ({
  file,
  sql: await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'),
})));
// Presence is intentionally based on the successfully loaded, SHA-reviewed
// backend migration file rather than a formatting-sensitive source regex.
// Every byte of this bundle is disclosed by the dry-run SHA and must be
// reviewed again before --apply, so readiness cannot be changed by merely
// changing a comment or whitespace around a SQL expression.
const directWorkforceMigration = migrations.find(({ file }) =>
  file === '20261103_department_current_set_direct_workforce.sql');
const departmentOrganisationAuthMigration = migrations.find(({ file }) =>
  file === '20261104_department_current_set_department_organisation_auth.sql');
const assignmentAuthMigration = migrations.find(({ file }) =>
  file === '20261105_department_current_set_assignment_auth.sql');
const sha256 = createHash('sha256').update(migrations.map(item => `${item.file}\n${item.sql}`).join('\n-- next migration --\n')).digest('hex');

if (!apply) {
  console.log(JSON.stringify({
    dryRun: true,
    migrations: FILES.map(file => `supabase/migrations/${file}`),
    directWorkforceMigration: directWorkforceMigration
      ? `supabase/migrations/${directWorkforceMigration.file}` : null,
    departmentOrganisationAuthMigration: departmentOrganisationAuthMigration
      ? `supabase/migrations/${departmentOrganisationAuthMigration.file}` : null,
    assignmentAuthMigration: assignmentAuthMigration
      ? `supabase/migrations/${assignmentAuthMigration.file}` : null,
    rolloutReadiness: directWorkforceMigration && departmentOrganisationAuthMigration && assignmentAuthMigration
      ? 'ready-for-reviewed-apply'
      : 'blocked: direct-workforce config-v2 or required authorization migration is not present',
    sha256,
    writesPerformed: false,
    nextStep: 'Review this exact SHA-256, then run with --apply --review-sha256=<sha256>.',
  }, null, 2));
} else {
  if (!review || review.slice('--review-sha256='.length) !== sha256) {
    throw new Error('Reviewed migration SHA-256 is missing or does not match; no database was changed.');
  }
  if (!directWorkforceMigration) {
    throw new Error('Direct-workforce config-v2 migration is not present; no database was changed.');
  }
  if (!departmentOrganisationAuthMigration) {
    throw new Error('Department-organisation authorization migration is not present; no database was changed.');
  }
  if (!assignmentAuthMigration) {
    throw new Error('Explicit-assignment authorization migration is not present; no database was changed.');
  }
  const connectionString = process.env.DEST_DATABASE_URL;
  const restUrl = process.env.DEST_SUPABASE_URL;
  if (!connectionString || !restUrl
    || new URL(restUrl).hostname !== 'lvmzliemqnieeoruhkik.supabase.co') {
    throw new Error('Pinned destination credentials are unavailable; no database was changed.');
  }
  const parsed = new URL(connectionString);
  const allowed = new Set([
    'aws-1-eu-central-1.pooler.supabase.com',
    'db.lvmzliemqnieeoruhkik.supabase.co',
  ]);
  if (!allowed.has(parsed.hostname) || (parsed.port && parsed.port !== '5432')) {
    throw new Error('Destination SQL host pin mismatch; no database was changed.');
  }
  if (parsed.hostname.endsWith('.pooler.supabase.com')
    && !decodeURIComponent(parsed.username).endsWith(DESTINATION_PROJECT_SUFFIX)) {
    throw new Error('Shared pool username is not pinned to the BNMS Supabase project; no database was changed.');
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
  const caResponse = await fetch(DESTINATION_CA_URL);
  if (!caResponse.ok) throw new Error(`Destination CA download failed with HTTP ${caResponse.status}; no database was changed.`);
  const ca = await caResponse.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Destination CA download was not a PEM certificate; no database was changed.');
  const client = new pg.Client({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: parsed.hostname },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const tenant = await client.query(
      "SELECT id FROM public.tenant WHERE id = 'ff2df806-b321-4254-b651-3af11fccf1db' FOR KEY SHARE",
    );
    if (tenant.rowCount !== 1) throw new Error('Pinned BNMS tenant is unavailable; transaction rolled back.');
    for (const migration of migrations) await client.query(migration.sql);
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, sha256 }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}