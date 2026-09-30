import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '20261109_copy_role_access_settings.sql';
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))) {
    throw new Error('Supported arguments: --apply --review-sha256=<sha256>');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) throw new Error('Reviewed migration SHA-256 missing or mismatched');
  const target = destinationTarget(env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if (!response.ok) throw new Error('Unable to fetch destination CA');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination CA');
  const client = new pg.Client({ connectionString: target.toString(), ssl: { rejectUnauthorized: true, ca, servername: target.hostname } });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '120s'");
    await client.query(sql);
    const { rows } = await client.query(`
      SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public']::text[]
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS valid
      FROM pg_proc p WHERE p.oid = 'public.copy_role_access_settings(uuid,uuid,uuid,boolean)'::regprocedure
    `);
    if (rows.length !== 1 || !rows[0].valid) throw new Error('RPC security verification failed');
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, migration: MIGRATION, sha256, target: 'DEST', securityVerified: true }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Migration failed; no success confirmed. Verify SQL, destination pins and TLS.');
    process.exitCode = 1;
  });
}