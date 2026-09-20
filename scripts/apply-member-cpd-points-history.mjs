#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

export const MIGRATION = '20261118_member_cpd_points_history.sql';
const CA_URL = 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

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
  if (!args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Migration hash does not match reviewed SQL.');
  }
  const target = destinationTarget(env);
  const response = await fetch(CA_URL);
  if (!response.ok) throw new Error('Unable to obtain destination TLS certificate.');
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Invalid destination TLS certificate.');
  const client = new pg.Client({
    connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: target.hostname },
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(sql);
    const { rows } = await client.query(`
      SELECT p.prosecdef,
        p.proconfig = ARRAY['search_path=public']::text[] AS safe_search_path,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
        has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
        EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
        ) AS public_execute
      FROM pg_proc p
      WHERE p.oid='public.get_member_cpd_points_history(uuid,uuid,integer,integer)'::regprocedure
    `);
    const fn = rows[0];
    if (!fn?.prosecdef || !fn.safe_search_path || !fn.service_execute
      || fn.anon_execute || fn.authenticated_execute || fn.public_execute) {
      throw new Error('CPD history function security verification failed.');
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, migration: MIGRATION, target: 'verified DEST Supabase', sha256 }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}