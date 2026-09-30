#!/usr/bin/env node
// Destination only. Default is offline SHA review; never implicitly apply.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const MIGRATION = '20261107_custom_object_relationship_deleted_members.sql';
const PROJECT = 'lvmzliemqnieeoruhkik';
const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';

export function destinationTarget(env) {
  if (!env.DEST_DATABASE_URL || !env.DEST_SUPABASE_URL) {
    throw new Error('Pinned destination credentials are unavailable; no database was changed.');
  }
  const rest = new URL(env.DEST_SUPABASE_URL);
  const parsed = new URL(env.DEST_DATABASE_URL);
  if (rest.origin !== `https://${PROJECT}.supabase.co`
    || rest.username || rest.password || rest.search || rest.hash
    || (rest.pathname !== '/' && rest.pathname !== '')) {
    throw new Error('Destination Supabase origin pin mismatch; no database was changed.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || ![`db.${PROJECT}.supabase.co`, 'aws-1-eu-central-1.pooler.supabase.com'].includes(parsed.hostname)
    || (parsed.port && parsed.port !== '5432')
    || parsed.pathname !== '/postgres'
    || parsed.hash) {
    throw new Error('Destination SQL host pin mismatch; no database was changed.');
  }
  const user = decodeURIComponent(parsed.username);
  if (user !== (parsed.hostname.endsWith('.pooler.supabase.com') ? `postgres.${PROJECT}` : 'postgres')) {
    throw new Error('Destination SQL user pin mismatch; no database was changed.');
  }
  // Do not let libpq query parameters override TLS, host, database or user.
  // These TLS parameters are discarded in favor of the verified TLS config.
  for (const key of [...parsed.searchParams.keys()]) {
    if (!['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].includes(key)) {
      throw new Error('Unexpected destination connection parameter; no database was changed.');
    }
    parsed.searchParams.delete(key);
  }
  return parsed;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--apply' && !/^--review-sha256=[a-f0-9]{64}$/.test(arg))
    || args.filter(arg => arg === '--apply').length > 1
    || args.filter(arg => arg.startsWith('--review-sha256=')).length > 1) {
    throw new Error('Supported arguments are --apply and --review-sha256=<sha256>.');
  }
  const sql = await readFile(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ dryRun: true, migration: MIGRATION, sha256, writesPerformed: false }));
    return;
  }
  if (!args.includes(`--review-sha256=${sha256}`)) {
    throw new Error('Reviewed migration SHA-256 is missing or does not match; no database was changed.');
  }
  const target = destinationTarget(env);
  const response = await fetch(DESTINATION_CA_URL);
  if (!response.ok) throw new Error(`Destination CA download failed with HTTP ${response.status}; no database was changed.`);
  const ca = await response.text();
  if (!ca.includes('BEGIN CERTIFICATE')) throw new Error('Destination CA download was not a PEM certificate; no database was changed.');
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
    const verification = await client.query(`
      SELECT p.proname,
        p.prosecdef AND p.proconfig = ARRAY['search_path=public']::text[]
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
        )
        AND strpos(p.prosrc, '^deleted_.+@deleted[.]local$') > 0 AS valid
      FROM pg_proc p
      WHERE p.oid IN (
        'public.custom_object_record_relationship_list(uuid,uuid,boolean,jsonb,jsonb,jsonb,integer,integer)'::regprocedure,
        'public.custom_object_record_relationship_projection(uuid,uuid,jsonb,uuid[],integer)'::regprocedure
      )
    `);
    if (verification.rowCount !== 2 || verification.rows.some(row => !row.valid)) {
      throw new Error('Relationship-list post-apply verification failed; transaction rolled back.');
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ applied: true, migration: MIGRATION, sha256 }));
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
    console.error('Migration failed; no success confirmed. Check the reviewed SQL, destination pins and verified TLS configuration.');
    process.exitCode = 1;
  });
}