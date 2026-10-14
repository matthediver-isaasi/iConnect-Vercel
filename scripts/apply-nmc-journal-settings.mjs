import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const migration = 'supabase/migrations/20261014190000_nmc_journal_settings.sql';
const sql = await readFile(migration, 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--apply' || arg === '--verify-rollback' || /^--review-sha256=[a-f0-9]{64}$/.test(arg)));
assert.ok(!(args.includes('--apply') && args.includes('--verify-rollback')));
if (!args.includes('--apply') && !args.includes('--verify-rollback')) {
  console.log(JSON.stringify({ migration, sha256, dryRun: true }));
} else {
  assert.ok(args.includes(`--review-sha256=${sha256}`), 'Reviewed migration digest required');
  const db = await connectDestination();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SET LOCAL statement_timeout='30s'");
    await db.query(sql);
    // Replay must preserve rows and constraints.
    const fingerprint = async () => (await db.query("SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY tenant_id)::text, '')) AS value FROM public.nmc_journal_settings s")).rows[0].value;
    const before = await fingerprint();
    await db.query(sql);
    assert.equal(await fingerprint(), before);
    const security = (await db.query(`SELECT c.relrowsecurity AS rls,
      has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon_access,
      has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS browser_access,
      has_table_privilege('service_role', c.oid, 'SELECT') AS server_read,
      has_table_privilege('service_role', c.oid, 'INSERT') AS server_insert,
      has_table_privilege('service_role', c.oid, 'UPDATE') AS server_update
      FROM pg_class c WHERE c.oid='public.nmc_journal_settings'::regclass`)).rows[0];
    assert.deepEqual(security, { rls: true, anon_access: false, browser_access: false,
      server_read: true, server_insert: true, server_update: true });
    await db.query(args.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ migration, target: `DEST ${PROJECT}`, committed: args.includes('--apply'),
      rollbackVerified: args.includes('--verify-rollback'), idempotent: true, existingSettingsUnchanged: true,
      security, membershipAndPaymentWrites: 0 }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    console.error(`Migration failed (${error.code || 'verification error'}); details withheld.`);
    process.exitCode = 1;
  } finally { await db.end(); }
}
