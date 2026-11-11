import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectDestination } from './lib/member-index-destination.mjs';

const migration = 'supabase/migrations/202701190001_member_cpd_ownership.sql';
const scopeMigration = 'supabase/migrations/202701190002_cpd_organization_tenant_scope.sql';
const lifecycleMigration = 'supabase/migrations/202701190003_cpd_transferred_lifecycle.sql';
const sql = [migration, scopeMigration, lifecycleMigration].map(file => readFileSync(file, 'utf8')).join('\n');
const hash = createHash('sha256').update(sql).digest('hex');
if (!process.argv.includes('--apply')) {
  console.log(JSON.stringify({ migration, sha256: hash, writes: false }));
} else {
  assert.ok(process.argv.includes(`--review-sha256=${hash}`), 'Reviewed migration hash required');
  const db = await connectDestination();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    // The file's transaction delimiters are omitted so verification is part of
    // the same transaction. No member merge or fixture is run on DEST.
    await db.query(sql.replace(/^BEGIN;$/gm, '').replace(/^COMMIT;$/gm, ''));
    const { rows: [grants] } = await db.query(`SELECT
      has_function_privilege('service_role','public.transfer_member_cpd(uuid,uuid,uuid,uuid)','EXECUTE') AS service,
      has_function_privilege('anon','public.transfer_member_cpd(uuid,uuid,uuid,uuid)','EXECUTE') AS anon,
      has_function_privilege('authenticated','public.transfer_member_cpd(uuid,uuid,uuid,uuid)','EXECUTE') AS authenticated,
      has_table_privilege('authenticated','public.member_cpd_effective_ledger','SELECT') AS browser_read`);
    assert.deepEqual(grants, { service: true, anon: false, authenticated: false, browser_read: false });
    await db.query("NOTIFY pgrst, 'reload schema'");
    await db.query('COMMIT');
    console.log(JSON.stringify({ migration, sha256: hash, applied: true, grantsVerified: true, memberMerges: 0 }));
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
}
