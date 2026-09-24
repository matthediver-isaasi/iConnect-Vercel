#!/usr/bin/env node
/**
 * Reviewed, destination-pinned installer for task 4759.
 *
 * Dry-run by default. A write requires both --apply and the exact SHA-256
 * printed by the dry run, so changing even one migration byte invalidates a
 * prior review.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATION = 'migrations/20260720_booking_reversal_evidence.sql';
const DESTINATION_PROJECT = 'lvmzliemqnieeoruhkik';
const DESTINATION_PROJECT_SUFFIX = `.${DESTINATION_PROJECT}`;
const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const review = args.find(argument => argument.startsWith('--review-sha256='));

if (args.some(argument => argument !== '--apply' && !argument.startsWith('--review-sha256='))) {
  throw new Error('Supported arguments are --apply and --review-sha256=<sha256>.');
}

const sql = await readFile(new URL(`../${MIGRATION}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(`${MIGRATION}\n${sql}`).digest('hex');

if (!apply) {
  console.log(JSON.stringify({
    dryRun: true,
    migration: MIGRATION,
    destinationProject: DESTINATION_PROJECT,
    sha256,
    writesPerformed: false,
    nextStep: 'Review this exact SHA-256, then run with --apply --review-sha256=<sha256>.',
  }, null, 2));
  process.exit(0);
}

if (!review || review.slice('--review-sha256='.length) !== sha256) {
  throw new Error('Reviewed migration SHA-256 is missing or does not match; no database was changed.');
}

const connectionString = process.env.DEST_DATABASE_URL;
const restUrl = process.env.DEST_SUPABASE_URL;
if (!connectionString || !restUrl
  || new URL(restUrl).hostname !== `${DESTINATION_PROJECT}.supabase.co`) {
  throw new Error('Pinned destination credentials are unavailable; no database was changed.');
}

const parsed = new URL(connectionString);
const allowedHosts = new Set([
  'aws-1-eu-central-1.pooler.supabase.com',
  `db.${DESTINATION_PROJECT}.supabase.co`,
]);
if (!allowedHosts.has(parsed.hostname) || (parsed.port && parsed.port !== '5432')) {
  throw new Error('Destination SQL host pin mismatch; no database was changed.');
}
if (parsed.hostname.endsWith('.pooler.supabase.com')
  && !decodeURIComponent(parsed.username).endsWith(DESTINATION_PROJECT_SUFFIX)) {
  throw new Error('Shared pool username is not pinned to the destination Supabase project; no database was changed.');
}
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);

const caResponse = await fetch(DESTINATION_CA_URL);
if (!caResponse.ok) {
  throw new Error(`Destination CA download failed with HTTP ${caResponse.status}; no database was changed.`);
}
const ca = await caResponse.text();
if (!ca.includes('BEGIN CERTIFICATE')) {
  throw new Error('Destination CA download was not a PEM certificate; no database was changed.');
}

const client = new pg.Client({
  connectionString: parsed.toString(),
  ssl: { rejectUnauthorized: true, ca, servername: parsed.hostname },
});
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('task-4759-booking-reversal-evidence'))");

  const identity = await client.query(`
    SELECT
      current_database() = 'postgres' AS expected_database,
      EXISTS (SELECT 1 FROM public.tenant LIMIT 1) AS has_tenant,
      to_regclass('public.booking') IS NOT NULL AS has_booking,
      to_regclass('public.complex_event_booking') IS NOT NULL AS has_complex_booking
  `);
  const pin = identity.rows[0];
  if (!pin?.expected_database || !pin?.has_tenant || !pin?.has_booking || !pin?.has_complex_booking) {
    throw new Error('Destination schema identity check failed; transaction rolled back before migration SQL.');
  }

  await client.query(sql);

  const verification = await client.query(`
    SELECT
      to_regclass('public.booking_reversal_evidence') IS NOT NULL AS table_exists,
      c.relrowsecurity AS rls_enabled,
      NOT has_table_privilege('anon', c.oid, 'SELECT') AS anon_select_revoked,
      NOT has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select_revoked,
      has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS service_role_crud,
      (
        SELECT array_agg(a.attname ORDER BY a.attnum)
        FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ) = ARRAY[
        'id','tenant_id','booking_source','evidence_key','operation_key','leg',
        'provider','provider_id','amount_minor','currency','status','booking_ids',
        'group_reference','payment_reference','detail','updated_at'
      ]::name[] AS columns_exact,
      to_regclass('public.booking_reversal_provider_identity') IS NOT NULL AS provider_index,
      to_regclass('public.booking_reversal_scope') IS NOT NULL AS scope_index,
      to_regclass('public.booking_reversal_bookings') IS NOT NULL AS booking_index,
      (
        SELECT count(*) = 7
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = c.oid
          AND constraint_row.contype = 'c'
      ) AS seven_check_constraints,
      (
        SELECT count(*) = 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = c.oid
          AND constraint_row.contype = 'u'
      ) AS one_unique_constraint,
      (
        SELECT count(*) = 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = c.oid
          AND constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'public.tenant'::regclass
      ) AS tenant_fk
    FROM pg_class c
    WHERE c.oid = 'public.booking_reversal_evidence'::regclass
  `);
  const schema = verification.rows[0];
  if (!schema || Object.values(schema).some(value => value !== true)) {
    throw new Error('Installed booking reversal evidence schema failed verification; transaction rolled back.');
  }

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query('COMMIT');
  console.log(JSON.stringify({
    applied: true,
    destinationProject: DESTINATION_PROJECT,
    migration: MIGRATION,
    sha256,
    schema,
  }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}