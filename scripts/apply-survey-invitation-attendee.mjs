#!/usr/bin/env node
// Pinned DEST only; default mode never connects or writes.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATION = 'supabase/migrations/20261125_survey_invitation_attendee.sql';
const PROJECT = 'lvmzliemqnieeoruhkik';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) throw new Error('Only --apply and --review-sha256=<hash> accepted');
const sql = await readFile(new URL(`../${MIGRATION}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(`${MIGRATION}\n${sql}`).digest('hex');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, destinationProject: PROJECT, sha256, writesPerformed: false }));
  process.exit(0);
}
if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed hash required; no writes performed');
if (!process.env.DEST_DATABASE_URL || !process.env.DEST_SUPABASE_URL
  || new URL(process.env.DEST_SUPABASE_URL).hostname !== `${PROJECT}.supabase.co`) throw new Error('Pinned destination credentials unavailable');
const parsed = new URL(process.env.DEST_DATABASE_URL);
if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${PROJECT}.supabase.co`].includes(parsed.hostname)
  || (parsed.port && parsed.port !== '5432')
  || (parsed.hostname.endsWith('.pooler.supabase.com') && !decodeURIComponent(parsed.username).endsWith(`.${PROJECT}`))) throw new Error('Destination SQL identity mismatch');
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Supabase CA download failed');
const ca = await response.text();
if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid provider CA');
const client = new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: true, ca, servername: parsed.hostname } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('survey-invitation-attendee'))");
  const identity = await client.query(`SELECT current_database() = 'postgres' AS database_ok,
    to_regclass('public.certificate_survey_entitlement') IS NOT NULL AS grants_ok,
    to_regclass('public.member') IS NOT NULL AS member_ok,
    to_regclass('public.booking') IS NOT NULL AS booking_ok,
    to_regclass('public.complex_event_booking') IS NOT NULL AS complex_ok`);
  if (Object.values(identity.rows[0]).some(value => value !== true)) throw new Error('Destination schema identity mismatch');
  await client.query(sql);
  const verification = await client.query(`SELECT
    NOT has_table_privilege('anon','public.survey_invitation_attendee','SELECT') AS anon_denied,
    NOT has_table_privilege('authenticated','public.survey_invitation_attendee','INSERT') AS authenticated_denied,
    NOT has_table_privilege('service_role','public.survey_invitation_attendee','INSERT') AS direct_write_denied,
    has_function_privilege('service_role','public.confirm_survey_invitation_attendee(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text)','EXECUTE') AS service_rpc,
    NOT has_function_privilege('authenticated','public.confirm_survey_invitation_attendee(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text)','EXECUTE') AS member_rpc_denied,
    (SELECT relrowsecurity FROM pg_class WHERE oid='public.survey_invitation_attendee'::regclass) AS rls_enabled,
    (SELECT count(*)=4 FROM pg_trigger WHERE tgname IN ('invalidate_survey_attendee_booking',
      'invalidate_survey_attendee_complex_booking','invalidate_survey_attendee_member','invalidate_survey_attendee_entitlement')) AS triggers_ok`);
  if (Object.values(verification.rows[0]).some(value => value !== true)) throw new Error('Migration verification failed');
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query('COMMIT');
  console.log(JSON.stringify({ applied: true, migration: MIGRATION, destinationProject: PROJECT, sha256 }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally { await client.end(); }