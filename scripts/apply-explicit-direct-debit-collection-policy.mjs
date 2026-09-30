#!/usr/bin/env node
// DEST only; offline dry-run by default. Review the hash before applying.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '20261108_explicit_direct_debit_collection_policy.sql';
export const MIGRATIONS = [
  '20260924_gocardless_org_renewal_owners.sql',
  '20261108_direct_debit_dated_commitments.sql',
  MIGRATION,
  '20261109_gocardless_dynamic_term_completion.sql',
  '20261109_manage_monthly_collection_days.sql',
];
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || args.filter(arg => arg === '--apply').length > 1
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1) {
    throw new Error('Supported arguments: --apply --review-sha256=<reviewed hash>');
  }
  const sql = (await Promise.all(MIGRATIONS.map(async name => {
    const source = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
    // The runner owns one atomic transaction for the whole reviewed bundle.
    return `-- ${name}\n${source.replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, '')}`;
  }))).join('\n');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ destination: 'DEST', dryRun: true, migration: MIGRATION, migrations: MIGRATIONS, sha256, writesPerformed: false }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed SHA-256 does not match; no writes performed');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Unable to fetch verified destination CA');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query(sql);
    const verification = await client.query(`
      SELECT p.proname, p.prosecdef
        AND has_function_privilege('service_role',p.oid,'EXECUTE')
        AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
        AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS valid
      FROM pg_proc p WHERE p.oid IN (
        'public.reserve_gocardless_dynamic_collection(uuid,uuid,integer,date,jsonb,jsonb,text)'::regprocedure,
        'public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb)'::regprocedure,
        'public.complete_gocardless_dynamic_term(uuid,uuid)'::regprocedure,
        'public.prepare_gocardless_dynamic_completion_notice(uuid,uuid,jsonb)'::regprocedure,
        'public.claim_gocardless_dynamic_completion_delivery(uuid,uuid,text,jsonb)'::regprocedure,
        'public.finish_gocardless_dynamic_completion_delivery(uuid,uuid,uuid,text,jsonb)'::regprocedure,
        'public.resolve_gocardless_dynamic_completion_delivery(uuid,uuid,boolean,jsonb)'::regprocedure,
        'public.change_gocardless_collection_day(uuid,uuid,uuid,integer,boolean,date,text)'::regprocedure,
        'public.gocardless_dynamic_collection_due_date(uuid,integer)'::regprocedure)
    `);
    if (verification.rowCount !== 9 || verification.rows.some(row => !row.valid)) throw new Error('Dynamic collection RPC privilege verification failed');
    await client.query('COMMIT');
    console.log(JSON.stringify({ destination: 'DEST', applied: true, migration: MIGRATION, migrations: MIGRATIONS, sha256 }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('DEST migration failed; no success confirmed. Review the SQL, hash and destination TLS pins.'); process.exitCode = 1; });
}