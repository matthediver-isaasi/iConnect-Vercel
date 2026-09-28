#!/usr/bin/env node
// DEST-only migration. Dry run prints the review hash, never modifies data.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATION = 'supabase/migrations/20261124_certificate_test_delivery_purpose.sql';
const PROJECT = 'lvmzliemqnieeoruhkik';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) {
  throw new Error('Only --apply and --review-sha256=<hash> are accepted');
}
const sql = await readFile(new URL(`../${MIGRATION}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(`${MIGRATION}\n${sql}`).digest('hex');
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, destinationProject: PROJECT, sha256, writesPerformed: false }));
  process.exit(0);
}
if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Exact reviewed hash required; no writes performed');
if (!process.env.DEST_DATABASE_URL || !process.env.DEST_SUPABASE_URL
  || new URL(process.env.DEST_SUPABASE_URL).hostname !== `${PROJECT}.supabase.co`) {
  throw new Error('Pinned destination credentials unavailable; no writes performed');
}
const parsed = new URL(process.env.DEST_DATABASE_URL);
if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${PROJECT}.supabase.co`].includes(parsed.hostname)
  || (parsed.port && parsed.port !== '5432')
  || (parsed.hostname.endsWith('.pooler.supabase.com')
    && !decodeURIComponent(parsed.username).endsWith(`.${PROJECT}`))) {
  throw new Error('Destination SQL identity mismatch; no writes performed');
}
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
const caResponse = await fetch(CA_URL);
if (!caResponse.ok) throw new Error('Supabase CA download failed');
const ca = await caResponse.text();
if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid provider CA');
const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: true, ca, servername: parsed.hostname },
});
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('certificate-test-delivery-purpose'))");
  const identity = await client.query(`SELECT current_database() = 'postgres' AS database_ok,
    to_regclass('public.tenant') IS NOT NULL AS tenant_ok,
    to_regclass('public.booking') IS NOT NULL AS booking_ok,
    to_regclass('public.complex_event_booking') IS NOT NULL AS complex_booking_ok,
    to_regclass('public.attendee_cpd_certificate_delivery') IS NOT NULL AS delivery_ok`);
  if (Object.values(identity.rows[0]).some(value => value !== true)) throw new Error('Destination schema identity mismatch');

  // This migration is hashed with its original transaction delimiters; strip those delimiters
  // while executing so verification remains inside the rollback-safe transaction here.
  const migrationSql = sql
    .replace(/^BEGIN\s*;\s*$/im, '')
    .replace(/\s*COMMIT\s*;\s*$/i, '');
  await client.query(migrationSql);
  const verified = await client.query(`SELECT
    EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.attendee_cpd_certificate_delivery'::regclass
        AND attname = 'purpose' AND NOT attisdropped
    ) AS purpose_column_ok,
    EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'purpose' AND NOT a.attisdropped
      WHERE i.indrelid = 'public.attendee_cpd_certificate_delivery'::regclass
        AND idx.relname = 'attendee_cpd_certificate_delivery_unresolved'
        AND i.indisunique AND i.indisvalid
        AND a.attnum = ANY(i.indkey)
        AND pg_get_expr(i.indpred, i.indrelid) LIKE '%pending%'
        AND pg_get_expr(i.indpred, i.indrelid) LIKE '%unknown%'
    ) AS purpose_index_ok,
    to_regprocedure('public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)') IS NOT NULL AS purpose_function_ok,
    has_function_privilege('service_role',
      'public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)', 'EXECUTE') AS service_rpc_ok,
    NOT has_function_privilege('anon',
      'public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)', 'EXECUTE') AS anonymous_rpc_denied,
    NOT has_function_privilege('authenticated',
      'public.claim_attendee_cpd_certificate_delivery(uuid,text,uuid,uuid,text,text,text,jsonb,boolean,text)', 'EXECUTE') AS member_rpc_denied`);
  if (Object.values(verified.rows[0]).some(value => value !== true)) throw new Error('Migration verification failed');
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query('COMMIT');
  console.log(JSON.stringify({ applied: true, migration: MIGRATION, sha256, destinationProject: PROJECT }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}