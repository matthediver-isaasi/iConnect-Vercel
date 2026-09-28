#!/usr/bin/env node
// Dry-run by default; no generic/legacy DATABASE_URL fallback is permitted.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATION = 'supabase/migrations/20261120_attendee_cpd_certificate_delivery.sql';
const DESTINATION_PROJECT = 'lvmzliemqnieeoruhkik';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) {
  throw new Error('Supported arguments: --apply --review-sha256=<sha256>');
}
const sql = await readFile(new URL(`../${MIGRATION}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(`${MIGRATION}\n${sql}`).digest('hex');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, destinationProject: DESTINATION_PROJECT, sha256, writesPerformed: false }, null, 2));
  process.exit(0);
}
if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed migration hash required; no database changed.');
if (!process.env.DEST_DATABASE_URL || !process.env.DEST_SUPABASE_URL
  || new URL(process.env.DEST_SUPABASE_URL).hostname !== `${DESTINATION_PROJECT}.supabase.co`) {
  throw new Error('Pinned destination credentials unavailable; no database changed.');
}
const parsed = new URL(process.env.DEST_DATABASE_URL);
if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${DESTINATION_PROJECT}.supabase.co`].includes(parsed.hostname)
  || (parsed.port && parsed.port !== '5432')
  || (parsed.hostname.endsWith('.pooler.supabase.com') && !decodeURIComponent(parsed.username).endsWith(`.${DESTINATION_PROJECT}`))) {
  throw new Error('Destination SQL identity pin mismatch; no database changed.');
}
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
const response = await fetch(CA_URL);
if (!response.ok) throw new Error('Destination CA download failed; no database changed.');
const ca = await response.text();
if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA; no database changed.');
const client = new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: true, ca, servername: parsed.hostname } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("SET LOCAL statement_timeout='120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('task-4810-attendee-cpd-certificate'))");
  const identity = await client.query(`SELECT current_database()='postgres' AS expected_database,
    EXISTS(SELECT 1 FROM public.tenant LIMIT 1) AS has_tenant,
    to_regclass('public.booking') IS NOT NULL AS has_booking,
    to_regclass('public.complex_event_booking') IS NOT NULL AS has_complex_booking,
    to_regclass('public.event_cpd_certificate_config') IS NOT NULL AS has_config,
    to_regclass('public.cpd_certificate_template') IS NOT NULL AS has_templates`);
  if (Object.values(identity.rows[0]).some(value => value !== true)) throw new Error('Destination schema identity check failed.');
  await client.query(sql);
  const verification = await client.query(`SELECT c.relrowsecurity AS rls,
    NOT has_table_privilege('anon',c.oid,'SELECT') AS anon_revoked,
    NOT has_table_privilege('authenticated',c.oid,'SELECT') AS authenticated_revoked,
    has_table_privilege('service_role',c.oid,'SELECT') AS service_select,
    NOT has_table_privilege('service_role',c.oid,'INSERT,DELETE') AS direct_writes_revoked,
    has_column_privilege('service_role',c.oid,'status','UPDATE') AS outcome_update,
    NOT has_column_privilege('service_role',c.oid,'provenance','UPDATE') AS provenance_immutable,
    to_regclass('public.attendee_cpd_certificate_delivery_booking') IS NOT NULL AS booking_index,
    to_regclass('public.attendee_cpd_certificate_delivery_unresolved') IS NOT NULL AS unresolved_index,
    (SELECT count(*)=3 FROM pg_constraint WHERE conrelid=c.oid AND contype='c') AS checks,
    (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=c.oid AND contype='u') AS request_unique,
    (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=c.oid AND contype='f'
      AND confrelid='public.tenant'::regclass) AS tenant_fk,
    (SELECT array_agg(attname ORDER BY attnum) FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)
      = ARRAY['id','tenant_id','booking_source','booking_id','request_id','fingerprint','actor','recipient','provenance',
        'deliberate_resend','status','provider_message_id','error','created_at','updated_at']::name[] AS columns_exact,
    NOT has_function_privilege('anon','public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean)','EXECUTE') AS anon_rpc_revoked,
    NOT has_function_privilege('authenticated','public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean)','EXECUTE') AS authenticated_rpc_revoked,
    has_function_privilege('service_role','public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean)','EXECUTE') AS service_rpc
    FROM pg_class c WHERE c.oid='public.attendee_cpd_certificate_delivery'::regclass`);
  const schema = verification.rows[0];
  if (!schema || Object.values(schema).some(value => value !== true)) throw new Error('Installed delivery audit schema failed verification.');
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query('COMMIT');
  console.log(JSON.stringify({ applied: true, destinationProject: DESTINATION_PROJECT, migration: MIGRATION, sha256, schema }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}