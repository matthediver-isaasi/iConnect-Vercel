#!/usr/bin/env node

/**
 * #472: rewrite `value_map` Zoho-side identifiers from `actual_value`
 * to `display_value` for every tenant's picklist field mappings.
 *
 * Background:
 *   See `scripts/audit-picklist-value-map-display-vs-actual.mjs` for
 *   the full diagnosis. Pre-#472, the admin mapping modal saved Zoho
 *   picklist identifiers as `actual_value`. Zoho's API exchanges
 *   picklist values as `display_value`, so the runtime canonicaliser
 *   (now standardised on `display_value` in
 *   `getZohoCrmModuleFieldTypes`) misses these legacy keys until
 *   they're rewritten here.
 *
 *   This script walks every mapping row, fetches live Zoho metadata
 *   for the row's module, and rewrites:
 *     - `value_map.zoho_to_iconnect` keys: actual_value → display_value
 *     - `value_map.iconnect_to_zoho` values: actual_value → display_value
 *
 *   Options whose actual_value === display_value are skipped (no
 *   rewrite needed). Stored keys/targets that don't match any live
 *   option are left unchanged and reported as orphans (manual fix).
 *
 *   Idempotent. Dry-run by default — pass `--apply` to persist.
 *   Mirrors the conventions of
 *   `scripts/migrate-picklist-value-map-keys.mjs` (#468).
 *
 * Usage:
 *   node scripts/migrate-picklist-value-map-actual-to-display.mjs                       (DRY RUN — all tenants)
 *   node scripts/migrate-picklist-value-map-actual-to-display.mjs --tenant <uuid>       (single tenant)
 *   node scripts/migrate-picklist-value-map-actual-to-display.mjs --apply               (persist changes)
 */

import { createClient } from '@supabase/supabase-js';
import { getZohoCrmModuleFields } from '../api/_lib/zohoCrmClient.js';

if (process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
} else {
  console.error('Need DEST_SUPABASE_URL and DEST_SUPABASE_KEY to talk to the production DB.');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { apply: false, tenant: null };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a.startsWith('--tenant=')) args.tenant = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/migrate-picklist-value-map-actual-to-display.mjs [--dry-run | --apply] [--tenant <uuid>]');
      process.exit(0);
    } else {
      console.error(`Error: unknown flag "${a}". Use --help.`);
      process.exit(2);
    }
  }
  if (explicitDryRun && args.apply) {
    console.error('Error: --dry-run and --apply are mutually exclusive.');
    process.exit(2);
  }
  return args;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.DEST_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.DEST_SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false } });
}

function indexPicklistOptions(field) {
  const out = { displaySet: new Set(), actualToDisplay: new Map() };
  const pl = field?.pick_list_values;
  if (!Array.isArray(pl)) return out;
  for (const p of pl) {
    const dv = typeof p?.display_value === 'string' && p.display_value !== '' ? p.display_value : null;
    const av = typeof p?.actual_value === 'string' && p.actual_value !== '' ? p.actual_value : null;
    if (dv) out.displaySet.add(dv);
    if (dv && av && dv !== av && !out.actualToDisplay.has(av)) {
      out.actualToDisplay.set(av, dv);
    }
  }
  return out;
}

async function getModuleFields(tenantId, module, cache) {
  const key = `${tenantId}::${module}`;
  if (cache.has(key)) return cache.get(key);
  let entry;
  try {
    entry = { fields: await getZohoCrmModuleFields(tenantId, module) };
  } catch (err) {
    entry = { error: err?.message || String(err) };
  }
  cache.set(key, entry);
  return entry;
}

async function processTenant(supabase, tenantId, apply, fieldsCache) {
  const summary = {
    tenant_id: tenantId,
    mappings_scanned: 0,
    rows_with_changes: 0,
    z2i_keys_rewritten: 0,
    i2z_targets_rewritten: 0,
    z2i_keys_already_canonical: 0,
    i2z_targets_already_canonical: 0,
    z2i_orphans: 0,
    i2z_orphans: 0,
    z2i_collisions: 0,
    rows_persisted: 0
  };

  const { data: mappings, error: mErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('id, entity_type, zoho_module, field_mappings')
    .eq('tenant_id', tenantId);
  if (mErr) {
    console.error(`  [ERR] could not load mappings for tenant ${tenantId}: ${mErr.message}`);
    return summary;
  }
  if (!mappings || mappings.length === 0) {
    console.log(`  (no mapping rows for tenant ${tenantId})`);
    return summary;
  }

  const modules = new Set();
  for (const m of mappings) if (m?.zoho_module) modules.add(m.zoho_module);
  for (const mod of modules) await getModuleFields(tenantId, mod, fieldsCache);

  for (const mappingRow of mappings) {
    summary.mappings_scanned += 1;
    const meta = fieldsCache.get(`${tenantId}::${mappingRow.zoho_module}`);
    if (meta?.error) {
      console.log(`  [skip] mapping ${mappingRow.id} (${mappingRow.zoho_module}): ${meta.error}`);
      continue;
    }
    const liveFields = meta?.fields || [];
    const fieldsByName = new Map();
    for (const f of liveFields) if (f?.api_name) fieldsByName.set(f.api_name, f);

    const fms = Array.isArray(mappingRow.field_mappings) ? mappingRow.field_mappings : [];
    let rowDirty = false;
    const nextFms = fms.map(fm => {
      if (!fm || typeof fm !== 'object') return fm;
      const vm = fm.value_map;
      if (!vm || typeof vm !== 'object') return fm;
      const z2i = (vm.zoho_to_iconnect && typeof vm.zoho_to_iconnect === 'object') ? vm.zoho_to_iconnect : null;
      const i2z = (vm.iconnect_to_zoho && typeof vm.iconnect_to_zoho === 'object') ? vm.iconnect_to_zoho : null;
      if (!z2i && !i2z) return fm;
      const zField = fieldsByName.get(fm.zoho_field);
      if (!zField) return fm;
      const isPicklistLike = (zField.data_type || '').toLowerCase().includes('picklist');
      if (!isPicklistLike) return fm;
      const idx = indexPicklistOptions(zField);
      if (idx.displaySet.size === 0) return fm;

      const fieldLabel = `${fm.zoho_field}`;
      let dirty = false;

      // Rewrite z2i keys: actual_value → display_value. Two-pass so the
      // canonical-display set we check collisions against includes
      // entries that were already in the source map BEFORE we start
      // rewriting. Otherwise an early rewrite can hide a collision with
      // a later already-canonical entry of the same display value.
      let nextZ2I = z2i;
      if (z2i) {
        nextZ2I = { ...z2i };
        const existingCanonicalKeys = new Set(
          Object.keys(z2i).filter(k => idx.displaySet.has(k))
        );
        for (const [k, v] of Object.entries(z2i)) {
          if (idx.displaySet.has(k)) {
            // Already canonical — leave in place (already copied by spread).
            summary.z2i_keys_already_canonical += 1;
            continue;
          }
          const display = idx.actualToDisplay.get(k);
          if (display) {
            if (existingCanonicalKeys.has(display)) {
              // NON-DESTRUCTIVE COLLISION POLICY (#472): both an
              // already-canonical entry and a legacy entry exist for
              // the same display option. Do NOT drop either — leave
              // the legacy key in place so the admin can resolve in
              // the modal (the legacy key will surface as an orphan
              // once it no longer matches any active option).
              summary.z2i_collisions += 1;
              console.log(`    [${fieldLabel}] z2i COLLISION on "${display}" — kept canonical "${z2i[display]}" AND legacy "${k}"="${v}" (manual resolution needed)`);
              continue;
            }
            // Two legacy keys can also collide if they both alias to
            // the same display (e.g. distinct actual_values renamed to
            // the same display). Same policy: keep both legacy entries
            // unchanged, do not pick a winner.
            if (Object.prototype.hasOwnProperty.call(nextZ2I, display) && nextZ2I[display] !== v) {
              summary.z2i_collisions += 1;
              console.log(`    [${fieldLabel}] z2i COLLISION on "${display}" — two legacy keys would converge; kept "${nextZ2I[display]}" and left "${k}"="${v}" untouched (manual resolution needed)`);
              continue;
            }
            // Promote to canonical.
            nextZ2I[display] = v;
            delete nextZ2I[k];
            existingCanonicalKeys.add(display);
            console.log(`    [${fieldLabel}] z2i rewrite key "${k}" → "${display}" (target iConnect: "${v}")`);
            summary.z2i_keys_rewritten += 1;
            dirty = true;
            continue;
          }
          // Orphan: keep as-is (already copied by spread).
          summary.z2i_orphans += 1;
          console.log(`    [${fieldLabel}] z2i ORPHAN key "${k}" — no live option matches; kept as-is`);
        }
      }

      // Rewrite i2z targets: actual_value → display_value. Targets
      // (right-hand side) cannot collide with each other — multiple
      // iConnect keys legitimately route to the same Zoho display
      // value. So no collision policy is needed here.
      let nextI2Z = i2z;
      if (i2z) {
        nextI2Z = {};
        for (const [k, v] of Object.entries(i2z)) {
          if (typeof v !== 'string' || v === '') {
            nextI2Z[k] = v;
            continue;
          }
          if (idx.displaySet.has(v)) {
            summary.i2z_targets_already_canonical += 1;
            nextI2Z[k] = v;
            continue;
          }
          const display = idx.actualToDisplay.get(v);
          if (display) {
            nextI2Z[k] = display;
            console.log(`    [${fieldLabel}] i2z rewrite target "${v}" → "${display}" (from iConnect "${k}")`);
            summary.i2z_targets_rewritten += 1;
            dirty = true;
            continue;
          }
          // Orphan: keep as-is.
          nextI2Z[k] = v;
          summary.i2z_orphans += 1;
          console.log(`    [${fieldLabel}] i2z ORPHAN target "${v}" — no live option matches; kept as-is`);
        }
      }

      if (!dirty) return fm;
      rowDirty = true;
      const nextVm = { ...vm };
      if (nextZ2I) {
        if (Object.keys(nextZ2I).length > 0) nextVm.zoho_to_iconnect = nextZ2I;
        else delete nextVm.zoho_to_iconnect;
      }
      if (nextI2Z) {
        if (Object.keys(nextI2Z).length > 0) nextVm.iconnect_to_zoho = nextI2Z;
        else delete nextVm.iconnect_to_zoho;
      }
      const hasAny = Object.keys(nextVm).length > 0;
      return { ...fm, value_map: hasAny ? nextVm : undefined };
    });

    if (!rowDirty) continue;
    summary.rows_with_changes += 1;
    if (!apply) continue;

    const { error: uErr } = await supabase
      .from('zoho_crm_sync_mapping')
      .update({ field_mappings: nextFms, updated_at: new Date().toISOString() })
      .eq('id', mappingRow.id);
    if (uErr) {
      console.error(`  [ERR] update failed for mapping ${mappingRow.id}: ${uErr.message}`);
      continue;
    }
    summary.rows_persisted += 1;
    console.log(`  [ok] persisted ${mappingRow.entity_type}/${mappingRow.zoho_module} (${mappingRow.id})`);
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  console.log(`\n=== Migrate value_map Zoho keys: actual_value → display_value (#472) ===`);
  console.log(`apply=${args.apply}  tenant=${args.tenant || '(all)'}\n`);

  let tenantIds;
  if (args.tenant) {
    tenantIds = [args.tenant];
  } else {
    const { data: tenants, error: tErr } = await supabase
      .from('tenant')
      .select('id, name')
      .order('name', { ascending: true });
    if (tErr) {
      console.error(`FATAL: could not list tenants: ${tErr.message}`);
      process.exit(2);
    }
    tenantIds = (tenants || []).map(t => t.id);
  }

  const fieldsCache = new Map();
  const totals = {
    tenants: 0,
    mappings_scanned: 0,
    rows_with_changes: 0,
    z2i_keys_rewritten: 0,
    i2z_targets_rewritten: 0,
    z2i_keys_already_canonical: 0,
    i2z_targets_already_canonical: 0,
    z2i_orphans: 0,
    i2z_orphans: 0,
    z2i_collisions: 0,
    rows_persisted: 0
  };

  for (const tenantId of tenantIds) {
    console.log(`\n--- tenant ${tenantId} ---`);
    const s = await processTenant(supabase, tenantId, args.apply, fieldsCache);
    totals.tenants += 1;
    for (const k of Object.keys(totals)) {
      if (k === 'tenants') continue;
      if (Object.prototype.hasOwnProperty.call(s, k)) totals[k] += s[k];
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  tenants processed:                ${totals.tenants}`);
  console.log(`  mapping rows scanned:             ${totals.mappings_scanned}`);
  console.log(`  rows needing change:              ${totals.rows_with_changes}`);
  console.log(`  Z→I keys rewritten:               ${totals.z2i_keys_rewritten}`);
  console.log(`  Z→I keys already canonical:       ${totals.z2i_keys_already_canonical}`);
  console.log(`  Z→I keys orphaned (kept):         ${totals.z2i_orphans}`);
  console.log(`  Z→I collisions (both kept):       ${totals.z2i_collisions}`);
  console.log(`  I→Z targets rewritten:            ${totals.i2z_targets_rewritten}`);
  console.log(`  I→Z targets already canonical:    ${totals.i2z_targets_already_canonical}`);
  console.log(`  I→Z targets orphaned (kept):      ${totals.i2z_orphans}`);
  console.log(`  rows persisted:                   ${totals.rows_persisted}`);
  if (totals.z2i_collisions > 0) {
    console.log(`\n  WARNING: ${totals.z2i_collisions} Z→I collision(s) left untouched.`);
    console.log(`  Both the canonical and legacy keys were preserved — open the affected`);
    console.log(`  mapping(s) in Admin → Zoho CRM Sync and resolve manually before the`);
    console.log(`  legacy entry shows up as an orphan in the modal.`);
  }
  if (!args.apply) {
    console.log(`\n  DRY RUN — re-run with --apply to persist the rewrites.`);
  }
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
