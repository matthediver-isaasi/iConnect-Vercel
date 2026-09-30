import fs from 'node:fs/promises';
import pg from 'pg';
import { isApprovedDestinationSupabaseTarget } from './lib/destinationSupabaseTarget.mjs';

const connectionString = process.env.DEST_DATABASE_URL;
const destinationSupabaseUrl = process.env.DEST_SUPABASE_URL;
if (!connectionString) {
  throw new Error('DEST_DATABASE_URL is required; refusing to use SOURCE or generic DATABASE_URL.');
}
if (!destinationSupabaseUrl
    || !isApprovedDestinationSupabaseTarget(connectionString, destinationSupabaseUrl)) {
  throw new Error('DEST_DATABASE_URL does not match the verified destination Supabase project.');
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const sql = await fs.readFile(new URL('../migrations/add_organization_member_login_block.sql', import.meta.url), 'utf8');
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');

  const verification = await client.query(`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'organization'
          AND column_name = 'member_login_blocked'
      ) AS organization_column,
      to_regclass('public.member_login_session_revocation') IS NOT NULL AS member_ledger,
      to_regclass('public.organization_login_gate_generation') IS NOT NULL AS gate_ledger,
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.organization'::regclass
          AND tgname = 'organization_member_login_revoke_trigger'
          AND NOT tgisinternal
      ) AS manual_trigger,
      EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.session'::regclass
          AND tgname = 'member_login_session_generation_fence_trigger'
          AND NOT tgisinternal
      ) AS session_fence_trigger,
      (SELECT relrowsecurity AND relforcerowsecurity
       FROM pg_class WHERE oid = 'public.member_login_session_revocation'::regclass) AS member_ledger_rls,
      (SELECT relrowsecurity AND relforcerowsecurity
       FROM pg_class WHERE oid = 'public.session'::regclass) AS session_rls,
      NOT has_table_privilege('anon', 'public.member_login_session_revocation', 'SELECT,INSERT,UPDATE,DELETE')
        AS anon_cannot_access_ledger,
      NOT has_table_privilege('authenticated', 'public.session', 'SELECT,INSERT,UPDATE,DELETE')
        AS authenticated_cannot_access_session,
      NOT has_function_privilege(
        'anon', 'public.bump_member_login_generation(text,text)', 'EXECUTE'
      ) AS anon_cannot_execute_fence_function
  `);
  if (!Object.values(verification.rows[0] || {}).every(Boolean)) {
    throw new Error('Migration verification failed.');
  }
  console.log('Organisation login kill-switch migration applied and verified on DEST.');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await client.end();
}