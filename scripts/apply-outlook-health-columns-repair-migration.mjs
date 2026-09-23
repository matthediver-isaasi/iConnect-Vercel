#!/usr/bin/env node
// Destination only. Default mode is offline review; --preflight is read-only.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '20261121_outlook_health_columns_repair.sql';
const CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

export async function inspectDestination(client) {
  const columns = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outlook_connection'
      AND column_name IN ('health_state', 'health_error', 'health_checked_at')
    ORDER BY column_name
  `);
  const summary = await client.query(`
    SELECT count(*)::int AS connections,
      count(*) FILTER (
        WHERE lower(coalesce(scopes, '')) LIKE '%onlinemeetings.readwrite%'
          AND lower(coalesce(scopes, '')) LIKE '%onlinemeetingartifact.read.all%'
      )::int AS intended_healthy,
      count(*) FILTER (WHERE health_state IS NOT NULL)::int AS existing_health_states
    FROM public.outlook_connection
  `.replace(
    'count(*) FILTER (WHERE health_state IS NOT NULL)::int AS existing_health_states',
    columns.rows.some(row => row.column_name === 'health_state')
      ? 'count(*) FILTER (WHERE health_state IS NOT NULL)::int AS existing_health_states'
      : '0::int AS existing_health_states',
  ));
  return { columns: columns.rows, ...summary.rows[0] };
}

export async function assertPostconditions(client) {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM information_schema.columns
       WHERE table_schema='public' AND table_name='outlook_connection'
         AND column_name IN ('health_state','health_error','health_checked_at')) AS columns,
      (SELECT count(*)::int FROM pg_constraint
       WHERE conrelid='public.outlook_connection'::regclass
         AND conname='outlook_connection_health_state_check') AS constraints,
      (SELECT count(*)::int FROM public.outlook_connection
       WHERE health_state NOT IN
         ('healthy','reconnect_required','admin_consent_required','error')) AS invalid_states
  `);
  const state = result.rows[0];
  if (state.columns !== 3 || state.constraints !== 1 || state.invalid_states !== 0) {
    throw new Error('Outlook health-column post-apply verification failed; transaction rolled back.');
  }
  return state;
}

export async function runMigration(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(sql);
    const verification = await assertPostconditions(client);
    await client.query('COMMIT');
    return verification;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function connectDestination(env) {
  const target = destinationTarget(env);
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error(`Destination CA download failed with HTTP ${response.status}.`);
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Destination CA was not a PEM certificate.');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  await client.connect();
  return client;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => !['--apply', '--preflight'].includes(arg)
      && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || args.filter(arg => arg === '--apply').length > 1
    || args.filter(arg => arg === '--preflight').length > 1
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1
    || (args.includes('--apply') && args.includes('--preflight'))) {
    throw new Error('Supported modes: offline default, --preflight, or --apply --review-sha256=<sha256>.');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply') && !args.includes('--preflight')) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  if (args.includes('--apply') && !args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Reviewed migration SHA-256 is missing or does not match; no database was changed.');
  }
  const client = await connectDestination(env);
  try {
    if (args.includes('--preflight')) {
      await client.query('BEGIN READ ONLY');
      const readOnly = await client.query("SELECT current_setting('transaction_read_only') AS value");
      if (readOnly.rows[0]?.value !== 'on') throw new Error('Read-only preflight could not be established.');
      const report = await inspectDestination(client);
      await client.query('ROLLBACK');
      console.log(JSON.stringify({
        preflight: true, readOnly: true, migration: MIGRATION, sha256,
        writesPerformed: false, ...report,
      }));
      return;
    }
    const verification = await runMigration(client, sql);
    console.log(JSON.stringify({ applied: true, migration: MIGRATION, sha256, verification }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Migration failed; no success confirmed. Review destination pins, TLS, schema, and approved hash.');
    process.exitCode = 1;
  });
}