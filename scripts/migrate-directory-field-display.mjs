/**
 * One-off backfill: map each tenant's GLOBAL member_directory_display
 * custom-field toggles (custom_fields[fieldId] = {front,back} / boolean)
 * and field_order ('custom:<id>' positions) onto the NEW per-directory
 * display config stored in preference_field.directory_visibility:
 *
 *   { ids, labels, display: { [dirId]: { front, back, order } } }
 *
 * Preserves current effective visibility exactly: for every member-scope
 * field that has a directory_visibility ids list, each assigned directory
 * gets a display entry seeded from the global toggles (which previously
 * applied to ALL directories). Fields without directory_visibility JSON
 * (legacy show_in_member_directory boolean form) are skipped — they keep
 * falling back to the global toggles at read time.
 *
 * Idempotent: existing display entries are never overwritten; re-runs only
 * fill missing entries.
 *
 * Usage:
 *   node scripts/migrate-directory-field-display.mjs           # dry-run (default)
 *   node scripts/migrate-directory-field-display.mjs --apply   # write changes
 *   node scripts/migrate-directory-field-display.mjs --tenant=<uuid>
 *
 * Targets the DEST (prod) Supabase via service-role key.
 */
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const tenantArg = process.argv.find(a => a.startsWith('--tenant='));
const ONLY_TENANT = tenantArg ? tenantArg.split('=')[1] : null;

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function normalizeVisibility(value) {
  if (value === undefined || value === null) return { front: true, back: true };
  if (typeof value === 'boolean') return { front: value, back: value };
  if (typeof value === 'object') {
    return { front: value.front !== false, back: value.back !== false };
  }
  return { front: true, back: true };
}

function parseDirVis(raw) {
  if (!raw) return null;
  let vis = raw;
  if (typeof vis === 'string') {
    try { vis = JSON.parse(vis); } catch { return null; }
  }
  if (Array.isArray(vis)) return { ids: vis, labels: {}, display: {} };
  if (vis && typeof vis === 'object') {
    return {
      ids: Array.isArray(vis.ids) ? vis.ids : [],
      labels: (vis.labels && typeof vis.labels === 'object' && !Array.isArray(vis.labels)) ? vis.labels : {},
      display: (vis.display && typeof vis.display === 'object' && !Array.isArray(vis.display)) ? vis.display : {},
    };
  }
  return null;
}

async function fetchAll(table, build) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = build(sb.from(table)).order('id', { ascending: true }).range(from, from + page - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry-run'}${ONLY_TENANT ? ` (tenant ${ONLY_TENANT})` : ''}`);

  const settingsRows = await fetchAll('system_settings', q => {
    q = q.select('id, tenant_id, setting_value').eq('setting_key', 'member_directory_display');
    if (ONLY_TENANT) q = q.eq('tenant_id', ONLY_TENANT);
    return q;
  });
  const settingsByTenant = new Map();
  for (const row of settingsRows) {
    if (!row.tenant_id) continue;
    try {
      const parsed = JSON.parse(row.setting_value || '{}');
      if (parsed && typeof parsed === 'object') settingsByTenant.set(row.tenant_id, parsed);
    } catch { /* unparseable settings -> defaults */ }
  }

  const fields = await fetchAll('preference_field', q => {
    q = q.select('id, tenant_id, label, entity_scope, directory_visibility').eq('entity_scope', 'member');
    if (ONLY_TENANT) q = q.eq('tenant_id', ONLY_TENANT);
    return q;
  });

  let updated = 0, skippedNoVis = 0, skippedComplete = 0;
  for (const field of fields) {
    const parsed = parseDirVis(field.directory_visibility);
    if (!parsed || parsed.ids.length === 0) { skippedNoVis++; continue; }

    const settings = settingsByTenant.get(field.tenant_id) || {};
    const globalVis = normalizeVisibility(settings.custom_fields?.[field.id]);
    const fieldOrder = Array.isArray(settings.field_order) ? settings.field_order : [];
    const customOrder = fieldOrder.filter(k => typeof k === 'string' && k.startsWith('custom:'));
    const orderIdx = customOrder.indexOf(`custom:${field.id}`);

    const display = { ...parsed.display };
    let changed = false;
    for (const dirId of parsed.ids) {
      if (display[dirId] && typeof display[dirId] === 'object') continue; // never overwrite
      const entry = { front: globalVis.front, back: globalVis.back };
      if (orderIdx >= 0) entry.order = orderIdx;
      display[dirId] = entry;
      changed = true;
    }
    if (!changed) { skippedComplete++; continue; }

    const next = JSON.stringify({ ids: parsed.ids, labels: parsed.labels, display });
    console.log(`${APPLY ? 'UPDATE' : 'would update'} field ${field.id} (${field.label}) tenant ${field.tenant_id}: ${next}`);
    if (APPLY) {
      const { error } = await sb.from('preference_field')
        .update({ directory_visibility: next })
        .eq('id', field.id);
      if (error) throw new Error(`update ${field.id}: ${error.message}`);
    }
    updated++;
  }

  console.log(`Done. ${APPLY ? 'Updated' : 'Would update'}: ${updated}, skipped (no directory_visibility): ${skippedNoVis}, skipped (already migrated): ${skippedComplete}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
