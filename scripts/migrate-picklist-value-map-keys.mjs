#!/usr/bin/env node

/**
 * #468: migrate `value_map.iconnect_to_zoho` keys on every `custom:<id>`
 * field-mapping row to the canonical iConnect option-value shape.
 *
 * Background:
 *   `applyValueMap` looks up keys by the value the entity actually
 *   stores (the option `value`, resolved by `deriveCustomAllowedValues`).
 *   Older value_maps were authored against alternate shapes — option
 *   `name`, `key`, `label`, or even legacy option `id` — so the lookup
 *   missed, the raw value was forwarded unchanged, and the new
 *   picklist-omit guard in `applyMappingValueOutbound` would now drop
 *   those fields entirely (leaving Zoho to keep its existing value).
 *
 *   This migration rewrites stored keys to the canonical shape. The
 *   runtime alias-fallback in `applyValueMap` already recovers from
 *   pre-migration data — so this script is a defence-in-depth that
 *   removes the silent rewrite at the read path.
 *
 * Idempotent. Dry-run by default — pass `--apply` to persist.
 *
 * Usage:
 *   node scripts/migrate-picklist-value-map-keys.mjs                       (DRY RUN — all tenants)
 *   node scripts/migrate-picklist-value-map-keys.mjs --tenant <uuid>       (single tenant)
 *   node scripts/migrate-picklist-value-map-keys.mjs --apply               (persist changes)
 */

import { createClient } from '@supabase/supabase-js';

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
      console.log('Usage: node scripts/migrate-picklist-value-map-keys.mjs [--dry-run | --apply] [--tenant <uuid>]');
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

/**
 * Build alias→canonical map for one preference_field's options. The
 * canonical shape mirrors `deriveCustomAllowedValues` in
 * api/admin/zoho-crm-sync/metadata.js:
 *   value ?? key ?? name ?? label
 * (id intentionally NOT in the canonical resolution to avoid UUID
 * pollution; included only as a possible alias key.)
 */
function buildAliasMap(options) {
  const aliases = new Map();
  if (!Array.isArray(options)) return aliases;
  for (const opt of options) {
    if (opt == null || typeof opt !== 'object') continue;
    const canonical = opt.value ?? opt.key ?? opt.name ?? opt.label;
    if (canonical == null) continue;
    const canonicalStr = String(canonical);
    for (const k of [opt.value, opt.key, opt.name, opt.label, opt.id]) {
      if (k == null) continue;
      const ks = String(k);
      if (ks === '') continue;
      if (!aliases.has(ks)) aliases.set(ks, canonicalStr);
    }
  }
  return aliases;
}

async function processTenant(supabase, tenantId, apply) {
  const summary = {
    tenant_id: tenantId,
    mappings_scanned: 0,
    rows_with_changes: 0,
    keys_rewritten: 0,
    keys_already_canonical: 0,
    keys_unresolved: 0,
    rows_persisted: 0
  };

  // 1. Load all mapping rows for this tenant.
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

  // 2. Collect unique custom field ids referenced by all mapping rows.
  const fieldIds = new Set();
  for (const m of mappings) {
    summary.mappings_scanned += 1;
    const fms = Array.isArray(m.field_mappings) ? m.field_mappings : [];
    for (const fm of fms) {
      if (typeof fm?.iconnect_field !== 'string') continue;
      if (!fm.iconnect_field.startsWith('custom:')) continue;
      const id = fm.iconnect_field.slice('custom:'.length);
      if (id) fieldIds.add(id);
    }
  }
  if (fieldIds.size === 0) {
    console.log(`  (no custom: field mappings for tenant ${tenantId})`);
    return summary;
  }

  // 3. Load preference_field rows for those ids — only need options.
  const { data: prefFields, error: pErr } = await supabase
    .from('preference_field')
    .select('id, name, label, options')
    .eq('tenant_id', tenantId)
    .in('id', [...fieldIds]);
  if (pErr) {
    console.error(`  [ERR] could not load preference_field for tenant ${tenantId}: ${pErr.message}`);
    return summary;
  }
  const aliasByFieldId = new Map();
  for (const pf of prefFields || []) {
    aliasByFieldId.set(pf.id, { aliases: buildAliasMap(pf.options), label: pf.label || pf.name || pf.id });
  }

  // 4. Walk every mapping row, rewrite keys.
  for (const mappingRow of mappings) {
    const fms = Array.isArray(mappingRow.field_mappings) ? mappingRow.field_mappings : [];
    let rowDirty = false;
    const nextFms = fms.map(fm => {
      if (typeof fm?.iconnect_field !== 'string' || !fm.iconnect_field.startsWith('custom:')) return fm;
      const fieldId = fm.iconnect_field.slice('custom:'.length);
      const aliasEntry = aliasByFieldId.get(fieldId);
      if (!aliasEntry || aliasEntry.aliases.size === 0) return fm;
      const vm = (fm.value_map && typeof fm.value_map === 'object') ? fm.value_map : null;
      const i2z = (vm?.iconnect_to_zoho && typeof vm.iconnect_to_zoho === 'object') ? vm.iconnect_to_zoho : null;
      if (!i2z || Object.keys(i2z).length === 0) return fm;

      // Canonical-value set is the de-duplicated set of canonical
      // shapes. A key is "already canonical" if it's a value in the
      // alias map (i.e. it points to itself).
      const canonicalSet = new Set([...aliasEntry.aliases.values()]);
      const nextI2Z = {};
      let dirty = false;
      const collisions = [];
      for (const [k, v] of Object.entries(i2z)) {
        if (canonicalSet.has(k)) {
          summary.keys_already_canonical += 1;
          if (Object.prototype.hasOwnProperty.call(nextI2Z, k)) {
            collisions.push({ key: k, kept: nextI2Z[k], dropped: v });
            continue;
          }
          nextI2Z[k] = v;
          continue;
        }
        const canonical = aliasEntry.aliases.get(k);
        if (canonical) {
          if (Object.prototype.hasOwnProperty.call(nextI2Z, canonical)) {
            // Existing canonical entry takes precedence (idempotent).
            collisions.push({ key: canonical, kept: nextI2Z[canonical], dropped: v, original_key: k });
          } else {
            nextI2Z[canonical] = v;
            console.log(`    [${aliasEntry.label}] rewrite key "${k}" → "${canonical}"  (target Zoho value: "${v}")`);
            summary.keys_rewritten += 1;
            dirty = true;
          }
          continue;
        }
        // Unresolved: keep as-is so we don't drop user data.
        nextI2Z[k] = v;
        summary.keys_unresolved += 1;
        console.log(`    [${aliasEntry.label}] UNRESOLVED key "${k}" — no matching option, kept as-is`);
      }
      if (collisions.length > 0) {
        for (const c of collisions) {
          console.log(`    [${aliasEntry.label}] COLLISION on canonical "${c.key}" (kept "${c.kept}", dropped duplicate "${c.dropped}"${c.original_key ? ` from legacy key "${c.original_key}"` : ''})`);
        }
        dirty = true;
      }
      if (!dirty) return fm;
      rowDirty = true;
      return { ...fm, value_map: { ...vm, iconnect_to_zoho: nextI2Z } };
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

  console.log(`\n=== Migrate value_map keys to canonical iConnect option shape ===`);
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

  const totals = {
    tenants: 0,
    mappings_scanned: 0,
    rows_with_changes: 0,
    keys_rewritten: 0,
    keys_already_canonical: 0,
    keys_unresolved: 0,
    rows_persisted: 0
  };

  for (const tenantId of tenantIds) {
    console.log(`\n--- tenant ${tenantId} ---`);
    const s = await processTenant(supabase, tenantId, args.apply);
    totals.tenants += 1;
    totals.mappings_scanned += s.mappings_scanned;
    totals.rows_with_changes += s.rows_with_changes;
    totals.keys_rewritten += s.keys_rewritten;
    totals.keys_already_canonical += s.keys_already_canonical;
    totals.keys_unresolved += s.keys_unresolved;
    totals.rows_persisted += s.rows_persisted;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  tenants processed:        ${totals.tenants}`);
  console.log(`  mapping rows scanned:     ${totals.mappings_scanned}`);
  console.log(`  rows needing change:      ${totals.rows_with_changes}`);
  console.log(`  keys rewritten:           ${totals.keys_rewritten}`);
  console.log(`  keys already canonical:   ${totals.keys_already_canonical}`);
  console.log(`  keys unresolved (kept):   ${totals.keys_unresolved}`);
  console.log(`  rows persisted:           ${totals.rows_persisted}`);
  if (!args.apply) {
    console.log(`\n  DRY RUN — re-run with --apply to persist the rewrites.`);
  }
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
