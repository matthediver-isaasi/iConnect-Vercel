#!/usr/bin/env node
// Destination-only schema deployment. Never replays registrations.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const migration = 'supabase/migrations/20261123_event_cpd_points_safe_reprocessing.sql';
const destinationProject = 'lvmzliemqnieeoruhkik';
const args = process.argv.slice(2);
if (args.some(arg => !['--apply', '--preflight'].includes(arg) && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
  || (args.includes('--apply') && args.includes('--preflight'))) {
  throw new Error('Use --preflight or --apply --review-sha256=<hash>; no arguments is an offline dry run.');
}
const sql = await readFile(new URL(`../${migration}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(`${migration}\n${sql}`).digest('hex');
if (!args.includes('--apply') && !args.includes('--preflight')) {
  console.log(JSON.stringify({ dryRun: true, migration, destinationProject, sha256, writesPerformed: false }, null, 2));
  process.exit(0);
}
if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`)) {
  throw new Error('Exact reviewed migration hash required; no database changed.');
}
if (!process.env.DEST_DATABASE_URL || !process.env.DEST_SUPABASE_URL
  || new URL(process.env.DEST_SUPABASE_URL).hostname !== `${destinationProject}.supabase.co`) {
  throw new Error('Pinned destination credentials unavailable; no database changed.');
}
const parsed = new URL(process.env.DEST_DATABASE_URL);
if (!['aws-1-eu-central-1.pooler.supabase.com', `db.${destinationProject}.supabase.co`].includes(parsed.hostname)
  || (parsed.port && parsed.port !== '5432')
  || (parsed.hostname.endsWith('.pooler.supabase.com')
    && !decodeURIComponent(parsed.username).endsWith(`.${destinationProject}`))) {
  throw new Error('Destination SQL identity pin mismatch; no database changed.');
}
for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) parsed.searchParams.delete(key);
const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
if (!response.ok) throw new Error('Destination CA download failed; no database changed.');
const ca = await response.text();
if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA; no database changed.');
const client = new pg.Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: true, ca, servername: parsed.hostname } });
await client.connect();
try {
  await client.query(args.includes('--preflight') ? 'BEGIN READ ONLY' : 'BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("SET LOCAL statement_timeout='120s'");
  const identity = (await client.query(`SELECT current_database()='postgres' AS expected_database,
    EXISTS(SELECT 1 FROM public.tenant LIMIT 1) AS has_tenant,
    to_regclass('public.booking') IS NOT NULL AS has_booking,
    to_regclass('public.complex_event_booking') IS NOT NULL AS has_complex_booking,
    to_regclass('public.event_cpd_points_rule') IS NOT NULL AS has_rules,
    to_regprocedure('public.record_event_cpd_points_award(jsonb)') IS NOT NULL AS has_award_engine`)).rows[0];
  if (Object.values(identity).some(value => value !== true)) throw new Error('Destination schema identity check failed.');
  if (args.includes('--preflight')) {
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ preflight: true, destinationProject, migration, sha256, identity, writesPerformed: false }, null, 2));
  } else {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('event-cpd-points-safe-reprocessing-migration'))");
    await client.query(sql);
    // Every new function must be service-only, including helper evaluators.
    const functions = (await client.query(`SELECT p.oid::regprocedure::text AS signature,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      NOT has_function_privilege('anon',p.oid,'EXECUTE') AS anon_revoked,
      NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_revoked
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('preview_event_cpd_points_reprocessing','confirm_event_cpd_points_reprocessing',
         'event_cpd_points_reprocessing_results')`)).rows;
    if (functions.length !== 3 || functions.some(row => !row.service_execute || !row.anon_revoked || !row.authenticated_revoked)) {
      throw new Error('Reprocessing RPC privilege verification failed.');
    }
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, destinationProject, migration, sha256, functions, replayPerformed: false }, null, 2));
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  // Do not expose connection strings or provider error objects.
  console.error(`CPD reprocessing migration failed (${error.code || 'validation'}); transaction rolled back.`);
  process.exitCode = 1;
} finally {
  await client.end();
}