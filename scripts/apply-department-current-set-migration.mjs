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
  '20261106_department_current_set_survey_stamp.sql',
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
const surveyStampMigration = migrations.find(({ file }) =>
  file === '20261106_department_current_set_survey_stamp.sql');
function functionBody(migration, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = migration.sql.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?\\) RETURNS[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`),
  );
  if (!match) throw new Error(`Could not read reviewed body for ${functionName}.`);
  return match[1];
}
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
    surveyStampMigration: surveyStampMigration
      ? `supabase/migrations/${surveyStampMigration.file}` : null,
    rolloutReadiness: directWorkforceMigration && departmentOrganisationAuthMigration
      && assignmentAuthMigration && surveyStampMigration
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
  if (!surveyStampMigration) {
    throw new Error('Survey-stamp migration is not present; no database was changed.');
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

    // Refuse to run even the reviewed bundle over unexpected function drift.
    // The new core body is accepted too, making a reviewed re-apply idempotent.
    const contracts = await client.query(`
      SELECT expected.contract, expected.proc_oid::text AS procedure,
             procedure.prosrc AS source,
             procedure.prosecdef AS security_definer,
             procedure.proconfig = ARRAY['search_path=public']::text[] AS fixed_search_path,
             has_function_privilege('service_role', expected.proc_oid, 'EXECUTE') AS service_execute,
             has_function_privilege('authenticated', expected.proc_oid, 'EXECUTE') AS authenticated_execute,
             has_function_privilege('anon', expected.proc_oid, 'EXECUTE') AS anon_execute,
             EXISTS (
               SELECT 1
               FROM aclexplode(COALESCE(
                 procedure.proacl,
                 acldefault('f', procedure.proowner)
               )) privilege
               WHERE privilege.grantee = 0
                 AND privilege.privilege_type = 'EXECUTE'
             ) AS public_execute
      FROM (VALUES
        ('core', to_regprocedure('public.department_current_set_reconcile(uuid,uuid,uuid,uuid,uuid,text)')),
        ('reconcile_wrapper', to_regprocedure('public.department_current_set_reconcile_authenticated(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)')),
        ('load_wrapper', to_regprocedure('public.department_current_set_load_authenticated(uuid,uuid,uuid,uuid,text)')),
        ('auth_helper', to_regprocedure('public.department_current_set_assert_authorized(uuid,uuid,uuid,jsonb)')),
        ('respondent_helper', to_regprocedure('public.department_current_set_assert_respondent(uuid,uuid,uuid,jsonb)'))
      ) expected(contract, proc_oid)
      LEFT JOIN pg_catalog.pg_proc procedure ON procedure.oid = expected.proc_oid
    `);
    const expectedSources = new Map([
      ['core', [
        functionBody(directWorkforceMigration, 'department_current_set_reconcile'),
        functionBody(surveyStampMigration, 'department_current_set_reconcile'),
      ]],
      ['reconcile_wrapper', [
        functionBody(migrations.find(({ file }) => file === '20261102_department_current_set_auth.sql'),
          'department_current_set_reconcile_authenticated'),
      ]],
      ['load_wrapper', [
        functionBody(migrations.find(({ file }) => file === '20261102_department_current_set_auth.sql'),
          'department_current_set_load_authenticated'),
      ]],
      ['auth_helper', [
        functionBody(assignmentAuthMigration, 'department_current_set_assert_authorized'),
      ]],
      ['respondent_helper', [
        functionBody(assignmentAuthMigration, 'department_current_set_assert_respondent'),
      ]],
    ]);
    if (contracts.rowCount !== expectedSources.size
      || contracts.rows.some(row => !row.procedure
        || !expectedSources.get(row.contract)?.includes(row.source)
        || !row.security_definer
        || !row.fixed_search_path
        || row.authenticated_execute
        || row.anon_execute
        || row.public_execute
        || (['core', 'reconcile_wrapper', 'load_wrapper'].includes(row.contract)
          && !row.service_execute))) {
      throw new Error('Installed current-set function contract drifted; transaction rolled back before migration SQL.');
    }

    const destinationPins = await client.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM public.custom_object_definition object_definition
          WHERE object_definition.id = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid
            AND object_definition.tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
            AND object_definition.object_key = 'org_department'
            AND object_definition.status = 'active'
        ) AS object_valid,
        EXISTS (
          SELECT 1 FROM public.preference_field field
          WHERE field.id = 'c5dcd16c-e63e-49f2-b72f-b0caaa7c5903'::uuid
            AND field.tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
            AND field.name = 'survey_last_updated'
            AND field.field_type = 'date'
            AND field.is_active = true
            AND field.entity_scope = 'custom_object'
            AND field.custom_object_id = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'::uuid
        ) AS field_valid,
        EXISTS (
          SELECT 1 FROM public.department_current_set_config config
          WHERE config.tenant_id = 'ff2df806-b321-4254-b651-3af11fccf1db'::uuid
            AND config.form_id = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f'::uuid
            AND config.config->>'department_object_id'
              = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f'
            AND public.department_current_set_config_valid(config.config)
        ) AS config_valid
    `);
    const pins = destinationPins.rows[0];
    if (!pins?.object_valid || !pins?.field_valid || !pins?.config_valid) {
      throw new Error('Pinned survey-stamp metadata or configuration is unavailable; transaction rolled back before migration SQL.');
    }
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