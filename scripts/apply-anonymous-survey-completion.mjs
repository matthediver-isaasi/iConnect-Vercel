#!/usr/bin/env node
// Additive, pinned destination only. No source or generic DB fallback.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const args = process.argv.slice(2);
const policyLock = args.includes('--policy-lock');
const memberTenancy = args.includes('--member-tenancy');
if (memberTenancy && policyLock) throw new Error('Select only one migration');
const migration = memberTenancy
  ? 'supabase/migrations/20261129_survey_completion_member_tenancy.sql'
  : policyLock
  ? 'supabase/migrations/20261128_survey_response_policy_lock.sql'
  : 'supabase/migrations/20261127_anonymous_survey_completion.sql';
const project = 'lvmzliemqnieeoruhkik';
const sql = await readFile(new URL(`../${migration}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(`${migration}\n${sql}`).digest('hex');
if (args.some(arg => !['--apply','--policy-lock','--member-tenancy'].includes(arg) && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) throw new Error('Invalid argument');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, migration, project, sha256, writesPerformed: false }));
  process.exit(0);
}
if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed migration hash required');
if (!process.env.DEST_DATABASE_URL || !process.env.DEST_SUPABASE_URL
  || new URL(process.env.DEST_SUPABASE_URL).hostname !== `${project}.supabase.co`) throw new Error('Pinned destination unavailable');
const target = new URL(process.env.DEST_DATABASE_URL);
if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${project}.supabase.co`].includes(target.hostname)
  || (target.port && target.port !== '5432')
  || (target.hostname.endsWith('.pooler.supabase.com') && !decodeURIComponent(target.username).endsWith(`.${project}`))) throw new Error('SQL target mismatch');
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) target.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Provider CA unavailable');
const ca = await response.text();
if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid provider CA');
const db = new pg.Client({ connectionString: target.toString(), ssl: { ca, rejectUnauthorized: true, servername: target.hostname } });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('anonymous-survey-completion'))");
  const identity = await db.query(`SELECT current_database()='postgres' AS db_ok,
    to_regclass('public.survey_version') IS NOT NULL AS survey_ok,
    to_regclass('public.survey_invitation_delivery') IS NOT NULL AS delivery_ok,
    to_regprocedure('public.create_survey_submission(jsonb,jsonb)') IS NOT NULL AS rpc_ok`);
  if (Object.values(identity.rows[0]).some(value => value !== true)) throw new Error('Destination schema mismatch');
  await db.query(sql);
  const verified = await db.query(`SELECT
    NOT has_table_privilege('anon','public.survey_completion','SELECT') AS anon_denied,
    NOT has_table_privilege('authenticated','public.survey_completion','SELECT') AS member_denied,
    NOT has_table_privilege('service_role','public.survey_completion','INSERT') AS direct_write_denied,
    NOT has_table_privilege('service_role','public.survey_completion_retry','SELECT') AS retry_read_denied,
    has_function_privilege('service_role','public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text)','EXECUTE') AS service_rpc,
    NOT has_function_privilege('authenticated','public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text)','EXECUTE') AS public_rpc_denied,
    (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.survey_completion'::regclass,'public.survey_completion_retry'::regclass)) AS rls_ok`);
  if (Object.values(verified.rows[0]).some(value => value !== true)) throw new Error('Migration privilege verification failed');
  if (policyLock) {
    const triggers = await db.query(`SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
      'guard_survey_form_response_policy','guard_survey_snapshot_response_policy','guard_survey_acceptance_response_policy')`);
    if (triggers.rows[0].n !== 3) throw new Error('Policy lock trigger verification failed');
  }
  await db.query("NOTIFY pgrst,'reload schema'");
  await db.query('COMMIT');
  console.log(JSON.stringify({ applied: true, project, migration, sha256, verification: verified.rows[0] }));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }