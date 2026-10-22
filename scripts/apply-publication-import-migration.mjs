#!/usr/bin/env node
// Offline by default. Applying requires separate owner approval and a reviewed hash.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '20261125_publication_import.sql';
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || new Set(args).size !== args.length) throw new Error('Use --apply --review-sha256=<reviewed hash>, or no arguments for offline review.');
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed migration hash does not match; no database changed.');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Unable to obtain destination TLS certificate.');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination TLS certificate.');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query(sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, ''));
    const { rows } = await client.query(`
      SELECT count(*)::int AS count, bool_and(
        has_function_privilege('service_role',p.oid,'EXECUTE')
        AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
        AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
        AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
      ) AS restricted FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN (
        'publication_import_identity','publication_import_snapshot',
        'publication_import_result','publication_import_apply')`);
    if (rows[0]?.count !== 4 || !rows[0]?.restricted) throw new Error('Import RPC privilege verification failed.');
    const { rows: tables } = await client.query(`
      SELECT relrowsecurity AND NOT has_table_privilege('anon',oid,'SELECT')
        AND NOT has_table_privilege('authenticated',oid,'SELECT') AS restricted
      FROM pg_class WHERE oid='public.publication_import_receipt'::regclass`);
    if (!tables[0]?.restricted) throw new Error('Import receipt privilege verification failed.');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: MIGRATION, sha256, destination: 'lvmzliemqnieeoruhkik',
      createdBriefs: 0, notificationsSent: 0 }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Publication import migration failed. No success is asserted; inspect the reviewed migration and destination configuration before retrying.');
    process.exitCode = 1;
  });
}
