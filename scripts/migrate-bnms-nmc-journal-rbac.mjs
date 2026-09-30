#!/usr/bin/env node
// Data-only migration. Dry run first; apply requires the reviewed snapshot hash.
import pg from 'pg';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { destinationTarget } from './apply-custom-object-relationship-deleted-members-migration.mjs';
import { LEGACY_TO_NEW_MAPPING } from '../api/_lib/roleAccessHierarchy.generated.js';

export const TENANT = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const MENU = '9a5aa193-6387-444d-9ee4-30c06763bb62';
export const LEGACY = 'page_user_NMCJournal';
export const KEY = 'content.nmc-journal';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function translateExclusions(values) {
  if (!Array.isArray(values) || !values.includes(LEGACY)) return values;
  // Retain every unrelated entry, including unknown keys and their order.
  let canonicalSeen = values.includes(KEY);
  return values.flatMap(value => {
    if (value !== LEGACY) return [value];
    if (canonicalSeen) return [];
    canonicalSeen = true;
    return [KEY];
  });
}

export async function runMigration(client, { apply = false, reviewedHash } = {}) {
  await client.query(`BEGIN ISOLATION LEVEL SERIALIZABLE ${apply ? '' : 'READ ONLY'}`);
  try {
    await client.query("SET LOCAL statement_timeout='30s'");
    await client.query("SET LOCAL lock_timeout='10s'");
    // Serialize inserts as well as updates, including concurrent reruns.
    if (apply) await client.query('LOCK TABLE role_access_item, portal_menu, portal_navigation_item, role IN SHARE ROW EXCLUSIVE MODE');
    const read = async (sql, values = []) => (await client.query(sql, values)).rows;
    const tenant = await read('SELECT id,name FROM tenant WHERE id=$1', [TENANT]);
    assert.equal(tenant[0]?.name, 'BNMS', 'Tenant identity mismatch');
    const menus = await read('SELECT * FROM portal_menu WHERE tenant_id=$1 ORDER BY id', [TENANT]);
    const nav = await read('SELECT * FROM portal_navigation_item WHERE tenant_id=$1 ORDER BY id', [TENANT]);
    const roles = await read('SELECT id,name,excluded_features FROM role WHERE tenant_id=$1 ORDER BY id', [TENANT]);
    const tree = await read('SELECT * FROM role_access_item ORDER BY id');
    const content = tree.filter(r => r.item_key === 'content');
    assert.equal(content.length, 1);
    assert.equal(content[0].item_type, 'module');
    assert.equal(content[0].is_active, true);
    const menu = menus.find(r => r.id === MENU);
    assert.ok(menu && menu.title === 'NMC Journal'
      && menu.url === 'https://journals.lww.com/nuclearmedicinecomm/pages/default.aspx'
      && menu.link_type === 'external' && [LEGACY, KEY].includes(menu.feature_id), 'Verified menu identity changed');
    assert.equal(menus.filter(r => [LEGACY, KEY].includes(r.feature_id)).length, 1, 'Unexpected menu references');
    assert.equal(nav.filter(r => [LEGACY, KEY].includes(r.feature_id)
      || [LEGACY, KEY].some(key => JSON.stringify(r.sub_items ?? null).includes(key))
      || r.title === 'NMC Journal').length, 0, 'New navigation references require review');
    const canonical = tree.filter(r => r.item_key === KEY);
    assert.ok(canonical.length <= 1, 'Duplicate canonical permission');
    if (canonical.length) {
      assert.equal(canonical[0].parent_id, content[0].id);
      assert.equal(canonical[0].item_type, 'page');
      assert.equal(canonical[0].label, 'NMC Journal');
      assert.equal(canonical[0].is_active, true);
    }
    // Never delete or repurpose a shared legacy row: other tenants may use it.
    // A newly appearing legacy row needs a fresh scoped review before proceeding.
    assert.equal(tree.filter(r => r.item_key === LEGACY).length, 0, 'Legacy tree row appeared; preserve it and review its references');
    const changes = roles.filter(r => JSON.stringify(translateExclusions(r.excluded_features)) !== JSON.stringify(r.excluded_features));
    const reviewHash = hash({ menus, nav, roles, tree });
    const report = {
      destination: 'DEST lvmzliemqnieeoruhkik', tenant: 'BNMS', reviewHash,
      permissionRowsInserted: canonical.length ? 0 : 1,
      menuRowsChanged: menu.feature_id === KEY ? 0 : 1,
      roleRowsChanged: changes.length,
      contentParentBlockedRoles: roles.filter(r => (r.excluded_features || [])
        .some(key => (LEGACY_TO_NEW_MAPPING[key] || key) === 'content')).map(r => r.name),
    };
    if (!apply) { await client.query('ROLLBACK'); return { ...report, dryRun: true }; }
    assert.equal(reviewedHash, reviewHash, 'Snapshot changed; run and review dry run again');
    const fingerprints = async () => read(`SELECT
      (SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) FROM portal_menu m WHERE id<>$1) menus,
      (SELECT md5(coalesce(jsonb_agg(to_jsonb(n) ORDER BY id)::text,'')) FROM portal_navigation_item n) nav,
      (SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'')) FROM role r WHERE NOT (id=ANY($2::uuid[]))) roles,
      (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'')) FROM role_access_item t WHERE item_key<>$3) tree`,
    [MENU, changes.map(r => r.id), KEY]);
    const before = await fingerprints();
    if (!canonical.length) await client.query(`INSERT INTO role_access_item
      (item_type,item_key,label,parent_id,display_order,is_active)
      VALUES ('page',$1,'NMC Journal',$2,$3,true)`,
    [KEY, content[0].id, Math.max(-1, ...tree.filter(r => r.parent_id === content[0].id).map(r => r.display_order || 0)) + 1]);
    if (report.menuRowsChanged) {
      const result = await client.query('UPDATE portal_menu SET feature_id=$1 WHERE id=$2 AND tenant_id=$3 AND feature_id=$4', [KEY, MENU, TENANT, LEGACY]);
      assert.equal(result.rowCount, 1);
    }
    for (const role of changes) {
      await client.query('UPDATE role SET excluded_features=$1 WHERE id=$2 AND tenant_id=$3',
        [JSON.stringify(translateExclusions(role.excluded_features)), role.id, TENANT]);
    }
    const afterMenu = (await read('SELECT * FROM portal_menu WHERE id=$1', [MENU]))[0];
    assert.deepEqual(afterMenu, { ...menu, feature_id: KEY }, 'Link presentation changed');
    assert.deepEqual(await fingerprints(), before, 'Unrelated settings changed');
    const afterRoles = await read('SELECT id,name,excluded_features FROM role WHERE tenant_id=$1 ORDER BY id', [TENANT]);
    assert.deepEqual(afterRoles, roles.map(r => ({ ...r, excluded_features: translateExclusions(r.excluded_features) })));
    await client.query('COMMIT');
    return { ...report, committed: true, linkSettingsUnchanged: true, unrelatedSettingsUnchanged: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.every(a => a === '--apply' || /^--review-sha256=[a-f0-9]{64}$/.test(a)), 'Invalid arguments');
  const target = destinationTarget(process.env);
  const response = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  assert.ok(response.ok, 'Provider CA unavailable');
  const client = new pg.Client({ connectionString: target.toString(),
    ssl: { rejectUnauthorized: true, ca: await response.text(), servername: target.hostname } });
  await client.connect();
  try {
    console.log(JSON.stringify(await runMigration(client, {
      apply: args.includes('--apply'),
      reviewedHash: args.find(a => a.startsWith('--review-sha256='))?.split('=')[1],
    }), null, 2));
  } finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.code ? `Database operation failed (${error.code}); no credentials logged.` : error.message);
    process.exitCode = 1;
  });
}