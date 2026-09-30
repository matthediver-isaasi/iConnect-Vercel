#!/usr/bin/env node

/**
 * #472: find `member_preference_value` / `organization_preference_value`
 * rows whose stored `value` is NOT a valid iConnect option for the
 * referenced `preference_field` — typically a Zoho `display_value`
 * long-form string that leaked in via a pre-#472 inbound sync that
 * couldn't translate the Zoho value through `value_map.zoho_to_iconnect`
 * (because the value_map keys were `actual_value` strings).
 *
 * For each leaked row, propose a rewrite:
 *   - First, look up `value_map.zoho_to_iconnect[value]` (post-migration
 *     this is keyed by display_value and yields the iConnect canonical).
 *   - Failing that, fall back to alias-resolution against the field's
 *     own options (option `name` / `key` / `label` → canonical `value`).
 *   - Otherwise: orphan (no automatic rewrite, manual fix needed).
 *
 * Read-only by default. Pass `--fix` to apply rewrites for non-orphan
 * findings. Pass `--tenant <uuid>` to scope to one tenant. Multi-pick
 * fields are out of scope (for now): they store JSON arrays / CSV
 * which need bespoke handling — the audit reports them with
 * `match='multi_pick_skipped'`.
 *
 * Usage:
 *   node scripts/audit-prefvalue-zoho-leaks.mjs                       (DRY RUN — all tenants)
 *   node scripts/audit-prefvalue-zoho-leaks.mjs --tenant <uuid>
 *   node scripts/audit-prefvalue-zoho-leaks.mjs --fix                 (persist rewrites)
 */

import { createClient } from '@supabase/supabase-js';

if (process.env.DEST_SUPABASE_URL && process.env.DEST_SUPABASE_KEY) {
  process.env.SUPABASE_URL = process.env.DEST_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_KEY = process.env.DEST_SUPABASE_KEY;
} else {
  console.error('Need DEST_SUPABASE_URL and DEST_SUPABASE_KEY to talk to the production DB.');
  process.exit(1);
}

const PREF_VALUE_TABLE = {
  member: 'member_preference_value',
  organization: 'organization_preference_value'
};
const PREF_VALUE_FK = {
  member: 'member_id',
  organization: 'organization_id'
};

function parseArgs(argv) {
  const args = { fix: false, tenant: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') args.fix = true;
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a.startsWith('--tenant=')) args.tenant = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/audit-prefvalue-zoho-leaks.mjs [--fix] [--tenant <uuid>]');
      process.exit(0);
    } else {
      console.error(`Error: unknown flag "${a}". Use --help.`);
      process.exit(2);
    }
  }
  return args;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.DEST_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.DEST_SUPABASE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false } });
}

const PICKLIST_LIKE_FIELD_TYPES = new Set([
  'picklist', 'dropdown', 'list', 'select',
  'radio', 'boolean', 'checkbox', 'yes_no'
]);
const MULTI_PICK_FIELD_TYPES = new Set([
  'multiselect', 'multi_select', 'multi-select', 'checkbox_group'
]);
// `deriveCustomAllowedValues` (api/admin/zoho-crm-sync/metadata.js)
// hard-codes a `true`/`false` allow-list for boolean-shaped field types
// regardless of whether the preference_field carries any options. Mirror
// that here so leaked Zoho strings on boolean fields ("True", "Yes",
// "1") are still classifiable as orphans, and stored canonical values
// ("true"/"false") aren't false-flagged.
const BOOLEAN_FIELD_TYPES = new Set(['boolean', 'checkbox', 'yes_no']);

/**
 * Mirror of `deriveCustomAllowedValues` (api/admin/zoho-crm-sync/metadata.js)
 * — value resolution: value ?? key ?? name ?? label. Returns Set<string> of
 * the canonical values, plus an alias map (every alternate shape →
 * canonical) so we can recover prefvalue rows that were saved against an
 * alternate shape.
 */
function indexFieldOptions(field) {
  const out = { canonicalSet: new Set(), aliasMap: new Map() };
  const ft = (field?.field_type || '').toLowerCase();
  if (BOOLEAN_FIELD_TYPES.has(ft)) {
    // Match `deriveCustomAllowedValues` exactly: canonical is the
    // string "true"/"false". Common Zoho-side leakage shapes are
    // mapped via the alias map so the audit will offer a rewrite.
    out.canonicalSet.add('true');
    out.canonicalSet.add('false');
    for (const k of ['true', 'True', 'TRUE', 'yes', 'Yes', 'YES', '1']) {
      out.aliasMap.set(k, 'true');
    }
    for (const k of ['false', 'False', 'FALSE', 'no', 'No', 'NO', '0']) {
      out.aliasMap.set(k, 'false');
    }
    // Fall through if the field also has explicit options (rare but
    // not impossible) so option-defined canonical values still win.
  }
  const opts = field?.options;
  if (!Array.isArray(opts)) return out;
  for (const o of opts) {
    if (o == null) continue;
    if (typeof o === 'string' || typeof o === 'number') {
      const s = String(o);
      if (s !== '') {
        out.canonicalSet.add(s);
        if (!out.aliasMap.has(s)) out.aliasMap.set(s, s);
      }
      continue;
    }
    if (typeof o !== 'object') continue;
    const canonical = o.value ?? o.key ?? o.name ?? o.label;
    if (canonical == null) continue;
    const cs = String(canonical);
    if (cs === '') continue;
    out.canonicalSet.add(cs);
    for (const k of [o.value, o.key, o.name, o.label, o.id]) {
      if (k == null) continue;
      const ks = String(k);
      if (ks === '') continue;
      if (!out.aliasMap.has(ks)) out.aliasMap.set(ks, cs);
    }
  }
  return out;
}

async function processTenantEntity(supabase, tenantId, entityType, fix) {
  const summary = {
    entity_type: entityType,
    fields_inspected: 0,
    rows_inspected: 0,
    rows_already_canonical: 0,
    rows_rewritten_via_z2i: 0,
    rows_rewritten_via_alias: 0,
    rows_orphan: 0,
    rows_multi_pick_skipped: 0,
    rows_persisted: 0
  };

  const { data: mappings, error: mErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('id, entity_type, zoho_module, field_mappings')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType);
  if (mErr) {
    console.error(`  [ERR] mappings load failed: ${mErr.message}`);
    return summary;
  }
  if (!mappings || mappings.length === 0) return summary;

  // Collect the iConnect ↔ Zoho-field-pair value_maps keyed by custom
  // field id. A custom field can appear in multiple mappings — merge
  // their z2i tables so we have the broadest possible alias coverage.
  const z2iByFieldId = new Map();
  for (const m of mappings) {
    const fms = Array.isArray(m.field_mappings) ? m.field_mappings : [];
    for (const fm of fms) {
      if (typeof fm?.iconnect_field !== 'string') continue;
      if (!fm.iconnect_field.startsWith('custom:')) continue;
      const id = fm.iconnect_field.slice('custom:'.length);
      const z2i = fm.value_map?.zoho_to_iconnect;
      if (!z2i || typeof z2i !== 'object') continue;
      const existing = z2iByFieldId.get(id) || {};
      for (const [k, v] of Object.entries(z2i)) {
        if (typeof k !== 'string' || k === '') continue;
        if (!Object.prototype.hasOwnProperty.call(existing, k)) existing[k] = v;
      }
      z2iByFieldId.set(id, existing);
    }
  }
  if (z2iByFieldId.size === 0) return summary;

  const fieldIds = [...z2iByFieldId.keys()];
  const { data: prefFields, error: pErr } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, options, entity_scope')
    .eq('tenant_id', tenantId)
    .in('id', fieldIds);
  if (pErr) {
    console.error(`  [ERR] preference_field load failed: ${pErr.message}`);
    return summary;
  }

  const tbl = PREF_VALUE_TABLE[entityType];
  const fk = PREF_VALUE_FK[entityType];

  for (const pf of prefFields || []) {
    if (!pf || pf.entity_scope !== entityType) continue;
    const ft = (pf.field_type || '').toLowerCase();
    const isMulti = MULTI_PICK_FIELD_TYPES.has(ft);
    if (!PICKLIST_LIKE_FIELD_TYPES.has(ft) && !isMulti) continue;
    summary.fields_inspected += 1;
    const idx = indexFieldOptions(pf);
    if (idx.canonicalSet.size === 0) continue;
    const z2i = z2iByFieldId.get(pf.id) || {};
    const fieldLabel = `${pf.label || pf.name} (${pf.id})`;

    const { data: prefValues, error: vErr } = await supabase
      .from(tbl)
      .select(`id, ${fk}, value`)
      .eq('field_id', pf.id);
    if (vErr) {
      console.error(`  [ERR] ${tbl} load failed for field ${pf.id}: ${vErr.message}`);
      continue;
    }
    for (const row of prefValues || []) {
      summary.rows_inspected += 1;
      const raw = row.value;
      if (raw === null || raw === undefined || raw === '') continue;

      if (isMulti) {
        // Multi-pick: out of scope for this auto-fix. Just count.
        summary.rows_multi_pick_skipped += 1;
        continue;
      }
      const v = String(raw);
      if (idx.canonicalSet.has(v)) {
        summary.rows_already_canonical += 1;
        continue;
      }
      // Try the merged value_map z2i first.
      let proposed = null;
      let via = null;
      if (Object.prototype.hasOwnProperty.call(z2i, v)) {
        const candidate = z2i[v];
        if (typeof candidate === 'string' && idx.canonicalSet.has(candidate)) {
          proposed = candidate;
          via = 'value_map';
        }
      }
      if (!proposed) {
        const aliasHit = idx.aliasMap.get(v);
        if (aliasHit && idx.canonicalSet.has(aliasHit)) {
          proposed = aliasHit;
          via = 'alias';
        }
      }
      if (!proposed) {
        summary.rows_orphan += 1;
        console.log(`    [${fieldLabel}] ORPHAN row ${row.id} ${fk}=${row[fk]}: value="${v}" — no rewrite found, kept as-is`);
        continue;
      }
      console.log(`    [${fieldLabel}] rewrite row ${row.id} ${fk}=${row[fk]}: "${v}" → "${proposed}" (via ${via})`);
      if (via === 'value_map') summary.rows_rewritten_via_z2i += 1;
      else summary.rows_rewritten_via_alias += 1;
      if (!fix) continue;
      const { error: uErr } = await supabase
        .from(tbl)
        .update({ value: proposed })
        .eq('id', row.id);
      if (uErr) {
        console.error(`    [ERR] update failed for row ${row.id}: ${uErr.message}`);
        continue;
      }
      summary.rows_persisted += 1;
    }
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  console.log(`\n=== Audit prefvalue rows for Zoho-leak strings (#472) ===`);
  console.log(`fix=${args.fix}  tenant=${args.tenant || '(all)'}\n`);

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
    fields_inspected: 0,
    rows_inspected: 0,
    rows_already_canonical: 0,
    rows_rewritten_via_z2i: 0,
    rows_rewritten_via_alias: 0,
    rows_orphan: 0,
    rows_multi_pick_skipped: 0,
    rows_persisted: 0
  };

  for (const tenantId of tenantIds) {
    console.log(`\n--- tenant ${tenantId} ---`);
    for (const entityType of ['member', 'organization']) {
      const s = await processTenantEntity(supabase, tenantId, entityType, args.fix);
      for (const k of Object.keys(totals)) {
        if (k === 'tenants') continue;
        if (Object.prototype.hasOwnProperty.call(s, k)) totals[k] += s[k];
      }
    }
    totals.tenants += 1;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  tenants processed:                ${totals.tenants}`);
  console.log(`  picklist fields inspected:        ${totals.fields_inspected}`);
  console.log(`  prefvalue rows inspected:         ${totals.rows_inspected}`);
  console.log(`  rows already canonical:           ${totals.rows_already_canonical}`);
  console.log(`  rows rewritten via value_map:     ${totals.rows_rewritten_via_z2i}`);
  console.log(`  rows rewritten via alias:         ${totals.rows_rewritten_via_alias}`);
  console.log(`  rows orphaned (kept):             ${totals.rows_orphan}`);
  console.log(`  rows multi-pick skipped:          ${totals.rows_multi_pick_skipped}`);
  console.log(`  rows persisted:                   ${totals.rows_persisted}`);
  if (!args.fix) {
    console.log(`\n  DRY RUN — re-run with --fix to persist the rewrites.`);
  } else {
    console.log(`\n  Reminder: run for both directions —`);
    console.log(`    1. scripts/migrate-picklist-value-map-actual-to-display.mjs --apply (first)`);
    console.log(`    2. scripts/audit-prefvalue-zoho-leaks.mjs --fix (this script)`);
    console.log(`  in that order so value_map z2i lookups resolve correctly.`);
  }
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
