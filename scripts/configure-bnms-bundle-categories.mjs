import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { connectDestination } from './lib/member-index-destination.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const expected = { Bronze: 31, Silver: 14, Gold: 3, Platinum: 1 };
const actor = 'bnms-exhibitor-category-setup';
const db = await connectDestination();
try {
  if (!process.argv.includes('--apply')) throw new Error('Use --apply for the approved migration and BNMS category assignment.');
  await db.query(readFileSync('supabase/migrations/202612310100_sales_bundle_categories.sql', 'utf8'));
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='10s'");
  const bundles = (await db.query('SELECT * FROM sales_catalogue_bundle WHERE tenant_id=$1 ORDER BY id FOR UPDATE', [tenant])).rows;
  const counts = {};
  for (const b of bundles) {
    const tier = /^(Bronze|Silver|Gold|Platinum) Sponsor - Stand \d+$/.exec(b.name)?.[1];
    if (!tier) throw new Error(`Unrecognised bundle title: ${b.name}`);
    counts[tier] = (counts[tier] || 0) + 1;
  }
  assert.deepEqual(counts, expected, 'BNMS bundle cohort changed; review before applying');
  const products = (await db.query('SELECT to_jsonb(p) AS row FROM sales_catalogue_product p WHERE tenant_id=$1 ORDER BY id', [tenant])).rows;
  const stock = (await db.query('SELECT to_jsonb(s) AS row FROM form_bundle_stock s WHERE tenant_id=$1 ORDER BY bundle_id', [tenant])).rows;
  const components = (await db.query('SELECT to_jsonb(i) AS row FROM sales_catalogue_bundle_item i WHERE tenant_id=$1 ORDER BY id', [tenant])).rows;
  let categoriesCreated = 0, bundlesUpdated = 0;
  const audit = (action, entityType, entityId, before, after) => db.query(
    `INSERT INTO sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data,after_data)
     VALUES($1,$2,'system',$3,$4,$5,$6,$7)`, [tenant, actor, action, entityType, entityId, before, after]);
  for (const tier of Object.keys(expected)) {
    const name = `${tier} Exhibitor`, code = `${tier.toUpperCase()}_EXHIBITOR`;
    const found = (await db.query('SELECT * FROM sales_catalogue_category WHERE tenant_id=$1 AND (name=$2 OR code=$3) FOR UPDATE', [tenant, name, code])).rows;
    if (found.length > 1 || found.some(c => c.name !== name || c.code !== code || !c.is_active || c.archived_at)) throw new Error(`Category conflict for ${name}`);
    let category = found[0];
    if (!category) {
      category = (await db.query(`INSERT INTO sales_catalogue_category(tenant_id,name,code,display_order,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$5) RETURNING *`, [tenant, name, code, Object.keys(expected).indexOf(tier) + 1, actor])).rows[0];
      await audit('category.created', 'sales_catalogue_category', category.id, null, category);
      categoriesCreated++;
    }
    for (const before of bundles.filter(b => b.name.startsWith(`${tier} Sponsor - `))) {
      if (before.category_id === category.id) continue;
      if (before.category_id) throw new Error(`Existing category requires review: ${before.name}`);
      const after = (await db.query(`UPDATE sales_catalogue_bundle SET category_id=$3,updated_by=$4,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND category_id IS NULL RETURNING *`, [tenant, before.id, category.id, actor])).rows[0];
      assert.ok(after);
      for (const key of Object.keys(before).filter(k => !['category_id', 'updated_at', 'updated_by'].includes(k))) assert.deepEqual(after[key], before[key], `Unexpected change: ${key}`);
      await audit('bundle.updated', 'sales_catalogue_bundle', before.id, before, after);
      bundlesUpdated++;
    }
  }
  assert.deepEqual((await db.query('SELECT to_jsonb(p) AS row FROM sales_catalogue_product p WHERE tenant_id=$1 ORDER BY id', [tenant])).rows, products);
  assert.deepEqual((await db.query('SELECT to_jsonb(s) AS row FROM form_bundle_stock s WHERE tenant_id=$1 ORDER BY bundle_id', [tenant])).rows, stock);
  assert.deepEqual((await db.query('SELECT to_jsonb(i) AS row FROM sales_catalogue_bundle_item i WHERE tenant_id=$1 ORDER BY id', [tenant])).rows, components);
  for (const role of ['anon', 'authenticated']) {
    const permissions = (await db.query(`SELECT
      has_function_privilege($1,'public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)','EXECUTE') AS create_allowed,
      has_function_privilege($1,'public.update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text)','EXECUTE') AS update_allowed,
      has_table_privilege($1,'public.sales_catalogue_bundle','UPDATE') AS direct_write`, [role])).rows[0];
    assert.deepEqual(permissions, { create_allowed: false, update_allowed: false, direct_write: false });
  }
  const summary = (await db.query(`SELECT c.name,count(*)::int AS bundles FROM sales_catalogue_bundle b
    JOIN sales_catalogue_category c ON c.tenant_id=b.tenant_id AND c.id=b.category_id
    WHERE b.tenant_id=$1 GROUP BY c.name ORDER BY c.name`, [tenant])).rows;
  await db.query('COMMIT');
  console.log(JSON.stringify({ categoriesCreated, bundlesUpdated, summary, preserved: 'products, prices, stock and components; service-only protections verified' }, null, 2));
} catch (error) {
  await db.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await db.end();
}
