#!/usr/bin/env node
// Destination only. Default is offline SHA review; never implicitly apply.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = 'dashboard_widget_result_cache.sql';
const DESTINATION_PROJECT = 'lvmzliemqnieeoruhkik';
const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

function transactionBody(sql) {
  const beginMatches = sql.match(/\bBEGIN\s*;/gi) || [];
  const commitMatches = sql.match(/\bCOMMIT\s*;/gi) || [];
  const begin = sql.search(/\bBEGIN\s*;/i);
  const commit = sql.search(/\bCOMMIT\s*;\s*$/i);
  if (beginMatches.length !== 1 || commitMatches.length !== 1 || begin < 0 || commit < begin) {
    throw new Error('Migration must contain exactly one outer BEGIN/COMMIT transaction.');
  }
  return sql.slice(begin + beginMatches[0].length, commit);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || args.filter(arg => arg === '--apply').length > 1
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1) {
    throw new Error('Supported arguments are --apply and --review-sha256=<sha256>.');
  }

  const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({
      dryRun: true,
      migration: MIGRATION,
      sha256,
      destinationProject: DESTINATION_PROJECT,
      writesPerformed: false,
    }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Reviewed migration SHA-256 is missing or does not match; no database was changed.');
  }

  const target = destinationTarget(env);
  const response = await fetch(DESTINATION_CA_URL);
  if (!response.ok) {
    throw new Error(`Destination CA download failed with HTTP ${response.status}; no database was changed.`);
  }
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) {
    throw new Error('Destination CA download was not a PEM certificate; no database was changed.');
  }

  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    // Keep post-apply verification in the same atomic transaction. The reviewed
    // migration owns an outer transaction for manual use, so the runner removes
    // only that verified wrapper and supplies its own.
    await client.query(transactionBody(sql));

    const tables = await client.query(`
      SELECT c.relname,
        c.relrowsecurity
          AND NOT has_table_privilege('anon', c.oid, 'SELECT')
          AND NOT has_table_privilege('authenticated', c.oid, 'SELECT')
          AND has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS valid
      FROM pg_class c
      WHERE c.oid IN (
        'public.dashboard_widget_result_cache'::regclass,
        'public.dashboard_widget_cache_tenants'::regclass,
        'public.dashboard_widget_refresh_limits'::regclass
      )
    `);
    if (tables.rowCount !== 3 || tables.rows.some(row => !row.valid)) {
      throw new Error('Cache table authorization verification failed; transaction rolled back.');
    }

    const functions = await client.query(`
      SELECT p.proname,
        p.proconfig = ARRAY['search_path=public']::text[]
          AND has_function_privilege('service_role', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
          ) AS valid
      FROM pg_proc p
      WHERE p.oid IN (
        'public.dashboard_widget_cache_identity(public.dashboard_widget)'::regprocedure,
        'public.dashboard_widget_cache_sync()'::regprocedure,
        'public.dashboard_widget_cache_touch(jsonb,uuid,boolean)'::regprocedure,
        'public.dashboard_widget_cache_claim(uuid,text)'::regprocedure,
        'public.dashboard_widget_cache_publish(uuid,text,uuid,jsonb,text)'::regprocedure,
        'public.dashboard_widget_cache_stats()'::regprocedure
      )
    `);
    if (functions.rowCount !== 6 || functions.rows.some(row => !row.valid)) {
      throw new Error('Cache function authorization verification failed; transaction rolled back.');
    }

    const integrity = await client.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'public.dashboard_widget'::regclass
            AND tgname = 'dashboard_widget_cache_sync'
            AND tgenabled <> 'D'
        ) AS trigger_valid,
        NOT EXISTS (
          SELECT 1
          FROM public.dashboard_widget w
          LEFT JOIN public.dashboard_widget_result_cache c ON c.widget_id = w.id
          WHERE c.widget_id IS NULL
            OR c.identity IS DISTINCT FROM public.dashboard_widget_cache_identity(w)
        ) AS backfill_valid
    `);
    if (!integrity.rows[0]?.trigger_valid || !integrity.rows[0]?.backfill_valid) {
      throw new Error('Cache trigger/backfill verification failed; transaction rolled back.');
    }

    await client.query('COMMIT');
    console.log(JSON.stringify({
      applied: true,
      migration: MIGRATION,
      sha256,
      destinationProject: DESTINATION_PROJECT,
      tablesVerified: tables.rowCount,
      functionsVerified: functions.rowCount,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never print connection details (which may include credentials).
  main().catch(() => {
    console.error(
      'Widget cache migration failed; no success confirmed. '
      + 'Check the reviewed SQL, destination pins and verified TLS configuration.',
    );
    process.exitCode = 1;
  });
}