/**
 * Apply the Ideal Postcodes durable rate-limit migration to the destination
 * Supabase database. Idempotent and safe to re-run.
 *
 * Usage:
 *   node scripts/apply-ideal-postcodes-rate-limit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationPath = 'supabase/migrations/20260903_ideal_postcodes_rate_limit.sql';
const sql = fs.readFileSync(path.join(repoRoot, migrationPath), 'utf8');

const connectionString = process.env.DEST_DATABASE_URL;
if (!connectionString) {
  console.error('DEST_DATABASE_URL must be set');
  process.exit(1);
}
const destinationSupabaseUrl = process.env.DEST_SUPABASE_URL;
if (!destinationSupabaseUrl) {
  console.error('DEST_SUPABASE_URL must be set to verify the destination project');
  process.exit(1);
}

if (!isApprovedDestinationSupabaseTarget(connectionString, destinationSupabaseUrl)) {
  console.error('DEST_DATABASE_URL does not match the configured destination Supabase project');
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query('BEGIN');
  console.log(`Applying ${migrationPath} ...`);
  await client.query(sql);

  const { rows } = await client.query(`
    SELECT
      to_regclass('public.address_lookup_rate_limit') IS NOT NULL AS table_exists,
      to_regprocedure(
        'public.consume_address_lookup_rate_limit(uuid,uuid,text,integer,integer)'
      ) IS NOT NULL AS function_exists,
      has_function_privilege(
        'service_role',
        'public.consume_address_lookup_rate_limit(uuid,uuid,text,integer,integer)',
        'EXECUTE'
      ) AS service_role_can_execute,
      has_function_privilege(
        'anon',
        'public.consume_address_lookup_rate_limit(uuid,uuid,text,integer,integer)',
        'EXECUTE'
      ) AS anon_can_execute,
      has_function_privilege(
        'authenticated',
        'public.consume_address_lookup_rate_limit(uuid,uuid,text,integer,integer)',
        'EXECUTE'
      ) AS authenticated_can_execute,
      p.prosecdef AS security_definer,
      p.proconfig @> ARRAY['search_path=public, pg_temp'] AS fixed_search_path,
      c.relrowsecurity AS row_security_enabled
    FROM pg_proc p
    JOIN pg_class c ON c.oid = 'public.address_lookup_rate_limit'::regclass
    WHERE p.oid = 'public.consume_address_lookup_rate_limit(uuid,uuid,text,integer,integer)'::regprocedure
  `);

  const result = rows[0];
  if (
    !result?.table_exists
    || !result?.function_exists
    || !result?.service_role_can_execute
    || result?.anon_can_execute
    || result?.authenticated_can_execute
    || !result?.security_definer
    || !result?.fixed_search_path
    || !result?.row_security_enabled
  ) {
    throw new Error('Address lookup rate-limit schema verification failed');
  }

  await client.query('COMMIT');
  console.log('Applied and verified Ideal Postcodes rate-limit schema.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}