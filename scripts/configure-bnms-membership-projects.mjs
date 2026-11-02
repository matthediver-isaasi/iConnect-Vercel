// Explicit destination-only schema/config rollout. No financial API writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const xeroTenant = '3d57dce6-2205-462f-abf6-9c7cbf00be23';
const migration = '202611020001_membership_xero_project_code.sql';
const sql = await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8');
const sha256 = createHash('sha256').update(sql).digest('hex');
const apply = process.argv.includes('--apply');
if (process.argv.some(arg => arg.startsWith('--') && arg !== '--apply' && !arg.startsWith('--review-sha256='))) {
  throw new Error('Unsupported argument');
}
if (!apply) {
  console.log(JSON.stringify({ offline: true, migration, sha256 }));
} else {
  assert.ok(process.argv.includes(`--review-sha256=${sha256}`), 'Reviewed migration hash required');
  const target = destinationTarget(process.env);
  const ca = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert.ok(ca.ok, 'Provider CA unavailable');
  const db = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true, ca: await ca.text(), servername: target.hostname } });
  try {
    await db.connect();
    const identity = (await db.query('SELECT id,name FROM public.tenant WHERE id=$1', [tenant])).rows;
    assert.equal(identity.length, 1);
    assert.match(identity[0].name, /BNMS|British Nuclear Medicine/i);
    const connection = (await db.query('SELECT tenant_id FROM public.xero_token WHERE app_tenant_id=$1', [tenant])).rows;
    assert.equal(connection.length, 1);
    assert.equal(connection[0].tenant_id, xeroTenant);
    // Pin before importing anything that initializes the application database.
    process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
    const { getValidXeroAccessToken } = await import('../api/_lib/xero.js');
    const auth = await getValidXeroAccessToken(tenant);
    assert.equal(auth.tenantId, xeroTenant);
    const response = await fetch('https://api.xero.com/api.xro/2.0/TrackingCategories', {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'xero-tenant-id': auth.tenantId, Accept: 'application/json' },
    });
    assert.ok(response.ok, `Tracking verification failed (${response.status})`);
    const categories = (await response.json()).TrackingCategories;
    const projects = categories?.filter(c => c.Name === 'Projects' && c.Status === 'ACTIVE');
    assert.equal(projects?.length, 1, 'Unique active Projects category required');
    assert.equal(projects[0].Options.filter(o => o.Name === 'MEMBERSHIPS' && o.Status === 'ACTIVE').length, 1);

    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await db.query('LOCK TABLE public.membership_tier_config IN SHARE ROW EXCLUSIVE MODE');
    const before = (await db.query('SELECT to_jsonb(c) row FROM public.membership_tier_config c ORDER BY id')).rows.map(r => r.row);
    assert.ok(before.some(r => r.tenant_id === tenant), 'No BNMS pricing schedules');
    await db.query(sql);
    // An update trigger could change updated_at. Reject, rather than weaken it.
    const changed = await db.query(`UPDATE public.membership_tier_config SET xero_project_code='MEMBERSHIPS'
      WHERE tenant_id=$1 AND xero_project_code IS DISTINCT FROM 'MEMBERSHIPS' RETURNING id`, [tenant]);
    const after = (await db.query('SELECT to_jsonb(c) row FROM public.membership_tier_config c ORDER BY id')).rows.map(r => r.row);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      const { xero_project_code: oldCode, ...oldRow } = before[i];
      const { xero_project_code: newCode, ...newRow } = after[i];
      assert.deepEqual(newRow, oldRow, 'Unrelated pricing data changed');
      assert.equal(newCode, oldRow.tenant_id === tenant ? 'MEMBERSHIPS' : oldCode ?? null);
    }
    await db.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
      VALUES($1,$2,$3) ON CONFLICT(version) DO NOTHING`,
    ['202611020001', 'membership_xero_project_code', [sql]]);
    await db.query("NOTIFY pgrst, 'reload schema'");
    const today = (await db.query('SELECT current_date::text today')).rows[0].today;
    const scoped = after.filter(r => r.tenant_id === tenant);
    const counts = { historical: 0, current: 0, future: 0 };
    for (const row of scoped) {
      counts[row.effective_from > today ? 'future' : row.effective_to && row.effective_to < today ? 'historical' : 'current']++;
    }
    await db.query('COMMIT');
    console.log(JSON.stringify({ migration, sha256, tenant, tenantName: identity[0].name, today,
      verifiedTrackingOption: 'Projects = MEMBERSHIPS', counts, total: scoped.length, changed: changed.rowCount,
      before: before.filter(r => r.tenant_id === tenant).map(r => ({ id: r.id, code: r.xero_project_code ?? null })),
      otherPricingFieldsAndTenantsUnchanged: true, issuedInvoiceAndSnapshotUpdates: 0, financialTransactions: 0 }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    // Never print provider responses, credentials or connection URLs.
    console.error(error instanceof pg.DatabaseError ? `Database operation failed: ${error.code}` : error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
