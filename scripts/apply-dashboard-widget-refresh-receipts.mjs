#!/usr/bin/env node
// Narrow forward migration. No implicit application or source fallback.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = 'dashboard_widget_refresh_receipts.sql';
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
      || new Set(args).size !== args.length
      || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1) {
    throw new Error('Supported arguments: --apply --review-sha256=<sha256>');
  }
  const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  const metadata = { migration: MIGRATION, sha256, destinationProject: 'lvmzliemqnieeoruhkik' };
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ ...metadata, dryRun: true, writesPerformed: false }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed SHA mismatch');
  const begin = sql.match(/\bBEGIN\s*;/gi) || [];
  const commit = sql.match(/\bCOMMIT\s*;/gi) || [];
  if (begin.length !== 1 || commit.length !== 1 || !/\bCOMMIT\s*;\s*$/.test(sql)) {
    throw new Error('Invalid migration transaction wrapper');
  }
  const body = sql.slice(sql.search(/\bBEGIN\s*;/i) + begin[0].length, sql.search(/\bCOMMIT\s*;\s*$/i));
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Destination CA unavailable');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    // Keep a row-level snapshot inside the transaction. DDL serializes writes;
    // lock first so concurrent scheduler publication cannot skew preservation.
    await client.query('LOCK TABLE public.dashboard_widget_result_cache IN ACCESS EXCLUSIVE MODE');
    await client.query(`CREATE TEMP TABLE cache_before ON COMMIT DROP AS
      SELECT widget_id,identity,result,updated_at,due_at,failures,error,lease_token,lease_until
      FROM public.dashboard_widget_result_cache`);
    await client.query(body);
    const preserved = await client.query(`SELECT NOT EXISTS (
      (SELECT * FROM cache_before EXCEPT SELECT widget_id,identity,result,updated_at,due_at,failures,error,lease_token,lease_until
        FROM public.dashboard_widget_result_cache)
      UNION ALL
      (SELECT widget_id,identity,result,updated_at,due_at,failures,error,lease_token,lease_until
        FROM public.dashboard_widget_result_cache EXCEPT SELECT * FROM cache_before)
      ) AS valid`);
    if (!preserved.rows[0]?.valid) throw new Error('Existing cache changed unexpectedly');
    const columns = await client.query(`SELECT count(*)::integer AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='dashboard_widget_result_cache'
      AND column_name IN ('request_id','lease_request_id','completed_request_id','completed_request_outcome')`);
    const acl = await client.query(`SELECT count(*)::integer AS n, bool_and(
      p.prosecdef AND p.proconfig=ARRAY['search_path=public']::text[]
      AND has_function_privilege('service_role',p.oid,'EXECUTE')
      AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
      AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE')) AS valid
      FROM pg_proc p WHERE p.oid IN (
        'public.dashboard_widget_cache_sync()'::regprocedure,
        'public.dashboard_widget_cache_touch(jsonb,uuid,boolean)'::regprocedure,
        'public.dashboard_widget_cache_claim(uuid,text)'::regprocedure,
        'public.dashboard_widget_cache_publish(uuid,text,uuid,jsonb,text)'::regprocedure)`);
    if (columns.rows[0]?.n !== 4 || acl.rows[0]?.n !== 4 || !acl.rows[0]?.valid) {
      throw new Error('Refresh receipt protocol verification failed');
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ ...metadata, applied: true, columnsVerified: 4, functionsVerified: 4, cachePreserved: true }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Refresh receipt migration failed; no success confirmed. Check destination pins, reviewed SQL and TLS.');
    process.exitCode = 1;
  });
}