/**
 * Apply and verify the destination-only event-card click tracking schema.
 *
 * Usage: node scripts/apply-event-card-click-tracking.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const migrationPath = 'supabase/migrations/20261026_event_card_click_tracking.sql';
const connectionString = process.env.DEST_DATABASE_URL;
const destinationSupabaseUrl = process.env.DEST_SUPABASE_URL;

if (!connectionString) {
  console.error('DEST_DATABASE_URL must be set');
  process.exit(1);
}
if (!destinationSupabaseUrl) {
  console.error('DEST_SUPABASE_URL must be set to verify the destination project');
  process.exit(1);
}
if (!isApprovedDestinationSupabaseTarget(connectionString, destinationSupabaseUrl)) {
  console.error('DEST_DATABASE_URL does not match the configured destination Supabase project');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(repoRoot, migrationPath), 'utf8');
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
      to_regclass('public.event_card_click') IS NOT NULL AS simple_table_exists,
      to_regclass('public.complex_event_card_click') IS NOT NULL AS complex_table_exists,
      to_regprocedure('public.record_event_card_click(uuid,uuid,text,text)') IS NOT NULL AS record_function_exists,
      to_regprocedure('public.get_event_card_click_counts(uuid,uuid[],uuid[])') IS NOT NULL AS counts_function_exists,
      has_function_privilege('service_role', 'public.record_event_card_click(uuid,uuid,text,text)', 'EXECUTE') AS service_can_record,
      has_function_privilege('service_role', 'public.get_event_card_click_counts(uuid,uuid[],uuid[])', 'EXECUTE') AS service_can_count,
      has_function_privilege('anon', 'public.record_event_card_click(uuid,uuid,text,text)', 'EXECUTE') AS anon_can_record,
      has_function_privilege('authenticated', 'public.record_event_card_click(uuid,uuid,text,text)', 'EXECUTE') AS authenticated_can_record,
      has_function_privilege('anon', 'public.get_event_card_click_counts(uuid,uuid[],uuid[])', 'EXECUTE') AS anon_can_count,
      has_function_privilege('authenticated', 'public.get_event_card_click_counts(uuid,uuid[],uuid[])', 'EXECUTE') AS authenticated_can_count,
      has_table_privilege('anon', 'public.event_card_click', 'SELECT') AS anon_can_read_simple,
      has_table_privilege('authenticated', 'public.event_card_click', 'SELECT') AS authenticated_can_read_simple,
      has_table_privilege('anon', 'public.complex_event_card_click', 'SELECT') AS anon_can_read_complex,
      has_table_privilege('authenticated', 'public.complex_event_card_click', 'SELECT') AS authenticated_can_read_complex,
      c1.relrowsecurity AS simple_rls,
      c1.relforcerowsecurity AS simple_force_rls,
      c2.relrowsecurity AS complex_rls,
      c2.relforcerowsecurity AS complex_force_rls,
      p1.prosecdef AS record_security_definer,
      p2.prosecdef AS counts_security_definer,
      p1.proconfig @> ARRAY['search_path=public, pg_temp'] AS record_fixed_search_path,
      p2.proconfig @> ARRAY['search_path=public, pg_temp'] AS counts_fixed_search_path
    FROM pg_class c1
    JOIN pg_class c2 ON c2.oid = 'public.complex_event_card_click'::regclass
    JOIN pg_proc p1 ON p1.oid = 'public.record_event_card_click(uuid,uuid,text,text)'::regprocedure
    JOIN pg_proc p2 ON p2.oid = 'public.get_event_card_click_counts(uuid,uuid[],uuid[])'::regprocedure
    WHERE c1.oid = 'public.event_card_click'::regclass
  `);

  const result = rows[0];
  const verified = result
    && result.simple_table_exists
    && result.complex_table_exists
    && result.record_function_exists
    && result.counts_function_exists
    && result.service_can_record
    && result.service_can_count
    && !result.anon_can_record
    && !result.authenticated_can_record
    && !result.anon_can_count
    && !result.authenticated_can_count
    && !result.anon_can_read_simple
    && !result.authenticated_can_read_simple
    && !result.anon_can_read_complex
    && !result.authenticated_can_read_complex
    && result.simple_rls
    && result.simple_force_rls
    && result.complex_rls
    && result.complex_force_rls
    && result.record_security_definer
    && result.counts_security_definer
    && result.record_fixed_search_path
    && result.counts_fixed_search_path;
  if (!verified) throw new Error('Event-card click schema verification failed');

  await client.query('COMMIT');
  console.log('Applied and verified event-card click tracking schema.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}