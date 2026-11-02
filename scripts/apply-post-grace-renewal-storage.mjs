import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectDestination } from './lib/member-index-destination.mjs';

const sql = await readFile(new URL('../supabase/migrations/20261103_post_grace_renewal_storage.sql', import.meta.url), 'utf8');
const hash = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ dryRun: true, sha256: hash, tenantEnablement: false, membershipWrites: false }));
} else {
  assert.deepEqual(args, ['--apply', `--review-sha256=${hash}`], 'Expected reviewed exact migration hash');
  const db = await connectDestination();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('post-grace-storage-migration',0))");
    // The reviewed migration has its own transaction for standalone execution.
    // Keep the DDL and access verification in this encompassing transaction.
    assert.equal((sql.match(/^BEGIN;$/gm) || []).length, 1);
    assert.equal((sql.match(/^COMMIT;$/gm) || []).length, 1);
    await db.query(sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
    const permissions = await db.query(`SELECT c.relname,c.relrowsecurity,
      has_table_privilege('anon',c.oid,'SELECT') anon_read,
      has_table_privilege('authenticated',c.oid,'SELECT') browser_read,
      has_table_privilege('service_role',c.oid,'INSERT') service_insert,
      has_table_privilege('service_role',c.oid,'UPDATE') service_update,
      has_table_privilege('service_role',c.oid,'DELETE') service_delete,
      has_table_privilege('service_role',c.oid,'SELECT') service_read
      FROM pg_class c WHERE c.oid IN ('public.membership_post_grace_policy'::regclass,'public.membership_post_grace_renewal'::regclass)`);
    assert.equal(permissions.rowCount, 2);
    for (const row of permissions.rows) {
      assert.equal(row.relrowsecurity, true);
      assert.equal(row.service_read, true);
      for (const key of ['anon_read','browser_read','service_insert','service_update','service_delete']) assert.equal(row[key], false, key);
    }
    const functions = await db.query(`SELECT p.prosecdef,
      p.proconfig = ARRAY['search_path=public, pg_temp']::text[] pinned_path,
      has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') browser_execute,
      EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
      FROM pg_proc p WHERE p.oid='public.record_post_grace_payment(uuid,uuid,uuid,text,text,text,timestamptz,bigint,text)'::regprocedure`);
    assert.deepEqual(functions.rows, [{ prosecdef: true, pinned_path: true, service_execute: true,
      anon_execute: false, browser_execute: false, public_execute: false }]);
    const enabled = (await db.query('SELECT count(*)::int count FROM public.membership_post_grace_policy WHERE enabled')).rows[0].count;
    const reservations = (await db.query('SELECT count(*)::int count FROM public.membership_post_grace_renewal')).rows[0].count;
    assert.equal(enabled, 0, 'Staged migration must not enable any tenant');
    assert.equal(reservations, 0, 'Staged migration must not create payment reservations');
    await db.query('COMMIT');
    console.log(JSON.stringify({ applied: true, sha256: hash, protectionsVerified: true,
      enabledTenants: enabled, reservations, membershipWrites: false }));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
}
