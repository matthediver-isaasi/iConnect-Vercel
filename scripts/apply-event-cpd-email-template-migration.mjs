#!/usr/bin/env node
// Destination-only, reviewed-hash migration runner. Never use runtime/SOURCE credentials.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { DESTINATION_PROJECT_REF, isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const args = process.argv.slice(2);
const renderedEmail = args.includes('--rendered-email');
const migration = renderedEmail ? 'supabase/migrations/20261122_attendee_cpd_rendered_email.sql'
  : 'supabase/migrations/20261121_event_cpd_email_template.sql';
if (args.some(arg => !['--apply', '--rendered-email'].includes(arg) && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) {
  throw new Error('Supported arguments: --rendered-email --apply --review-sha256=<sha256>');
}
const sql = await readFile(new URL(`../${migration}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(`${migration}\n${sql}`).digest('hex');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, migration, destinationProject: DESTINATION_PROJECT_REF, sha256, writesPerformed: false }, null, 2));
  process.exit(0);
}
if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed migration hash required.');
if (!isApprovedDestinationSupabaseTarget(process.env.DEST_DATABASE_URL, process.env.DEST_SUPABASE_URL)) {
  throw new Error('Destination identity pin mismatch; no database changed.');
}
const target = new URL(process.env.DEST_DATABASE_URL);
if (target.port && target.port !== '5432') throw new Error('Destination session connection required.');
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) target.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Destination CA download failed.');
const ca = await response.text();
if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA.');
const db = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='10s'");
  await db.query("SET LOCAL statement_timeout='120s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('task-4813-event-cpd-email-template'))");
  const identity = await db.query(`SELECT current_database()='postgres' AS expected_database,
    EXISTS(SELECT 1 FROM public.tenant LIMIT 1) AS has_tenants,
    to_regclass('public.event_cpd_certificate_config') IS NOT NULL AS has_config,
    to_regclass('public.email_template') IS NOT NULL AS has_email_templates,
    to_regclass('public.attendee_cpd_certificate_delivery') IS NOT NULL AS has_delivery_audit,
    to_regprocedure('public.replace_event_cpd_certificate_config(uuid,text,uuid,jsonb)') IS NOT NULL AS has_replace_rpc`);
  if (Object.values(identity.rows[0]).some(value => value !== true)) throw new Error('Destination schema identity check failed.');
  await db.query(sql);
  const result = await db.query(`SELECT
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.event_cpd_certificate_config'::regclass
      AND tgname='validate_event_cpd_email_template_config' AND tgenabled='O') AS trigger_enabled,
    NOT has_function_privilege('anon','public.validate_event_cpd_email_template_config()','EXECUTE') AS anon_revoked,
    NOT has_function_privilege('authenticated','public.validate_event_cpd_email_template_config()','EXECUTE') AS authenticated_revoked,
    has_function_privilege('service_role','public.replace_event_cpd_certificate_config(uuid,text,uuid,jsonb)','EXECUTE') AS service_rpc,
    NOT has_table_privilege('service_role','public.event_cpd_certificate_config','INSERT,UPDATE,DELETE') AS direct_writes_revoked`);
  if (Object.values(result.rows[0]).some(value => value !== true)) throw new Error('Installed email configuration validation failed.');
  let deliverySchema;
  if (renderedEmail) {
    const finalization = await db.query(`SELECT
      has_column_privilege('service_role','public.attendee_cpd_certificate_delivery','rendered_email','UPDATE') AS final_content_update,
      has_column_privilege('service_role','public.attendee_cpd_certificate_delivery','status','UPDATE') AS outcome_update,
      NOT has_column_privilege('service_role','public.attendee_cpd_certificate_delivery','provenance','UPDATE') AS initial_provenance_immutable,
      NOT has_column_privilege('service_role','public.attendee_cpd_certificate_delivery','fingerprint','UPDATE') AS fingerprint_immutable,
      NOT has_column_privilege('anon','public.attendee_cpd_certificate_delivery','rendered_email','UPDATE') AS anon_revoked,
      NOT has_column_privilege('authenticated','public.attendee_cpd_certificate_delivery','rendered_email','UPDATE') AS authenticated_revoked,
      NOT has_table_privilege('service_role','public.attendee_cpd_certificate_delivery','INSERT,DELETE') AS direct_writes_revoked`);
    deliverySchema = finalization.rows[0];
    if (Object.values(deliverySchema).some(value => value !== true)) throw new Error('Installed finalization column grants failed verification.');
  }
  await db.query("NOTIFY pgrst, 'reload schema'");
  await db.query('COMMIT');
  console.log(JSON.stringify({ applied: true, destinationProject: DESTINATION_PROJECT_REF, migration, sha256, schema: result.rows[0], deliverySchema }, null, 2));
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await db.end();
}