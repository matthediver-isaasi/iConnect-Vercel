/**
 * BNMS-only configuration repair. Read-only by default; --apply requires the
 * fresh --review-sha256 printed by the dry run. Never writes domain values.
 * New fields are automatically included by mergeLayoutWithCustomFields.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { connectDestination, PROJECT } from './lib/member-index-destination.mjs';

const tenant = 'ff2df806-b321-4254-b651-3af11fccf1db';
const fieldId = 'daf0ddcb-6007-4a21-aec3-38e577b4ff4c';
const apply = process.argv.includes('--apply');
const db = await connectDestination();
try {
  await db.query(apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  if (apply) await db.query('LOCK TABLE preference_field IN SHARE ROW EXCLUSIVE MODE');
  const identity = (await db.query('select id,slug,name from tenant where id=$1', [tenant])).rows;
  assert.equal(identity.length, 1);
  assert.equal(identity[0].slug, 'bnms');
  const fields = (await db.query('select to_jsonb(f) row from preference_field f where tenant_id=$1 order by id', [tenant])).rows.map(r => r.row);
  const candidates = fields.filter(f => /domain/i.test(f.name || '') || /domain/i.test(f.label || ''));
  assert.ok(candidates.length <= 1, 'Ambiguous domain definitions: inspect before repairing');
  const existing = candidates[0];
  if (existing) {
    assert.equal(existing.name, 'verified_domains');
    assert.equal(existing.entity_scope, 'organization');
    assert.equal(existing.field_type, 'list');
  }
  const settings = (await db.query(`select to_jsonb(s) row from system_settings s where tenant_id=$1
    and setting_key in ('org_detail_layout_config','org_field_visibility_rules') order by id`, [tenant])).rows.map(r => r.row);
  assert.ok(!settings.some(s => s.setting_key === 'org_field_visibility_rules'), 'Visibility rules require manual inspection');
  const values = (await db.query(`select count(*)::int count from organization_preference_value v
    join organization o on o.id=v.organization_id where o.tenant_id=$1
    and v.field_id=any($2::uuid[])`, [tenant, candidates.map(f => f.id)])).rows[0].count;
  const proposed = existing ? { ...existing, is_active: true } : {
    id: fieldId, tenant_id: tenant, name: 'verified_domains', label: 'Verified Domains',
    entity_scope: 'organization', field_type: 'list', is_active: true, is_required: false,
    is_filterable: false, display_order: Math.max(-1, ...fields.filter(f => f.entity_scope === 'organization').map(f => f.display_order || 0)) + 1,
    show_in_admin_list: true, show_in_admin_column: true, show_in_admin_filter: true,
    show_in_my_organisation: false, show_in_directory_card: false, directory_visibility: '[]',
  };
  const hash = createHash('sha256').update(JSON.stringify({ fields, settings, values, proposed })).digest('hex');
  const changed = !existing || !existing.is_active;
  if (apply && changed) {
    assert.ok(process.argv.includes(`--review-sha256=${hash}`), 'Fresh review hash required');
    if (existing) await db.query('update preference_field set is_active=true where id=$1 and tenant_id=$2', [existing.id, tenant]);
    else {
      const keys = Object.keys(proposed);
      await db.query(`insert into preference_field (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(proposed));
    }
    const after = (await db.query("select id from preference_field where tenant_id=$1 and name='verified_domains' and entity_scope='organization' and is_active", [tenant])).rows;
    assert.deepEqual(after, [{ id: proposed.id }]);
  }
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ project: PROJECT, tenant, diagnosis: existing ? (existing.is_active ? 'active' : 'inactive') : 'absent',
    applied: apply && changed, reviewSha256: hash, fieldId: proposed.id, existingValueCount: values,
    layoutChanged: false, valuesWritten: 0, proposed }, null, 2));
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
