#!/usr/bin/env node

/**
 * #472: audit every tenant's `field_mapping` rows for `value_map`
 * entries whose Zoho-side identifier is a picklist `actual_value` that
 * has a different `display_value` in live Zoho metadata.
 *
 * Background:
 *   Pre-#472, the admin mapping modal saved Zoho picklist
 *   identifiers as `actual_value` (with `display_value` shown only as
 *   the visible label). Zoho's API exchanges picklist values as
 *   `display_value` on both directions of the wire, so any saved
 *   `value_map` entry whose Zoho-side string is an `actual_value`
 *   that diverges from its `display_value` causes silent drift:
 *     - outbound: iConnect pushes the `actual_value`, which Zoho
 *       stores literally rather than the renamed `display_value`,
 *     - inbound: Zoho sends the `display_value`, the lookup misses,
 *       the raw long-form string is written verbatim into the
 *       iConnect cell.
 *
 *   This script is read-only: it reports per-tenant per-mapping
 *   what the migration script would rewrite.
 *
 * Usage:
 *   node scripts/audit-picklist-value-map-display-vs-actual.mjs
 *   node scripts/audit-picklist-value-map-display-vs-actual.mjs --tenant <uuid>
 *   node scripts/audit-picklist-value-map-display-vs-actual.mjs --json
 *
 * Note:
 *   Fetches Zoho picklist metadata via the same in-process module
 *   client used by the API. Each tenant must have a working Zoho CRM
 *   integration; tenants without one are skipped with a one-line
 *   note.
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
  const args = { tenant: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') args.tenant = argv[++i];
    else if (a.startsWith('--tenant=')) args.tenant = a.split('=')[1];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/audit-picklist-value-map-display-vs-actual.mjs [--tenant <uuid>] [--json]');
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

/**
 * For one Zoho field's picklist, build maps used to classify each
 * stored `value_map` identifier:
 *   - displaySet: every live `display_value` (canonical wire form).
 *   - actualToDisplay: actual_value → display_value, only when they
 *     differ. A stored key that's in this map is the smoking gun
 *     pre-#472 bug — it should be rewritten to its display_value.
 *
 * Options whose actual_value === display_value are NOT in
 * `actualToDisplay` (no rewrite needed). Options marked `unused` are
 * still included so historical mappings can be classified, not just
 * silently flagged as orphans.
 */
function indexPicklistOptions(field) {
  const out = { displaySet: new Set(), actualSet: new Set(), actualToDisplay: new Map() };
  const pl = field?.pick_list_values;
  if (!Array.isArray(pl)) return out;
  for (const p of pl) {
    const dv = typeof p?.display_value === 'string' && p.display_value !== '' ? p.display_value : null;
    const av = typeof p?.actual_value === 'string' && p.actual_value !== '' ? p.actual_value : null;
    if (dv) out.displaySet.add(dv);
    if (av) out.actualSet.add(av);
    if (dv && av && dv !== av) {
      // Only the first occurrence wins — Zoho should never produce two
      // options sharing an actual_value, so collisions here are noise.
      if (!out.actualToDisplay.has(av)) out.actualToDisplay.set(av, dv);
    }
  }
  return out;
}

function classify(storedKey, idx) {
  if (typeof storedKey !== 'string' || storedKey === '') return { match: 'invalid', proposed: null };
  if (idx.displaySet.has(storedKey)) return { match: 'display_match', proposed: null };
  // actual_value with a different display_value — the rewrite case.
  if (idx.actualToDisplay.has(storedKey)) {
    return { match: 'actual_match', proposed: idx.actualToDisplay.get(storedKey) };
  }
  // actual_value === display_value (already in displaySet above caught
  // these). If the key matches an actualSet entry but not displaySet,
  // that means the option had display_value missing — treat as
  // already-correct (no rewrite). Otherwise: orphan.
  if (idx.actualSet.has(storedKey)) return { match: 'display_missing', proposed: null };
  return { match: 'orphan', proposed: null };
}

async function getModuleFields(tenantId, module, cache) {
  const key = `${tenantId}::${module}`;
  if (cache.has(key)) return cache.get(key);
  let fields = null;
  try {
    fields = await getZohoCrmModuleFields(tenantId, module);
  } catch (err) {
    cache.set(key, { error: err?.message || String(err) });
    return cache.get(key);
  }
  cache.set(key, { fields });
  return cache.get(key);
}

async function processTenant(supabase, tenantId, fieldsCache) {
  const summary = {
    tenant_id: tenantId,
    mappings_scanned: 0,
    rows_with_findings: 0,
    z2i_keys_actual_match: 0,
    z2i_keys_orphan: 0,
    i2z_targets_actual_match: 0,
    i2z_targets_orphan: 0,
    skipped_modules: [] // [{ module, reason }]
  };
  const findings = []; // human-readable rows

  const { data: mappings, error: mErr } = await supabase
    .from('zoho_crm_sync_mapping')
    .select('id, entity_type, zoho_module, field_mappings')
    .eq('tenant_id', tenantId);
  if (mErr) {
    console.error(`  [ERR] could not load mappings for tenant ${tenantId}: ${mErr.message}`);
    return { summary, findings };
  }
  if (!mappings || mappings.length === 0) return { summary, findings };

  // Pre-fetch metadata for the modules referenced by this tenant.
  const modules = new Set();
  for (const m of mappings) {
    if (m?.zoho_module) modules.add(m.zoho_module);
  }
  for (const mod of modules) {
    await getModuleFields(tenantId, mod, fieldsCache);
  }

  for (const mappingRow of mappings) {
    summary.mappings_scanned += 1;
    const fms = Array.isArray(mappingRow.field_mappings) ? mappingRow.field_mappings : [];
    const meta = fieldsCache.get(`${tenantId}::${mappingRow.zoho_module}`);
    if (meta?.error) {
      const tag = `${mappingRow.zoho_module}`;
      if (!summary.skipped_modules.find(s => s.module === tag)) {
        summary.skipped_modules.push({ module: tag, reason: meta.error });
      }
      continue;
    }
    const liveFields = meta?.fields || [];
    const fieldsByName = new Map();
    for (const f of liveFields) if (f?.api_name) fieldsByName.set(f.api_name, f);

    let rowHasFinding = false;
    for (const fm of fms) {
      if (!fm || typeof fm !== 'object') continue;
      const vm = fm.value_map;
      if (!vm || typeof vm !== 'object') continue;
      const z2i = (vm.zoho_to_iconnect && typeof vm.zoho_to_iconnect === 'object') ? vm.zoho_to_iconnect : {};
      const i2z = (vm.iconnect_to_zoho && typeof vm.iconnect_to_zoho === 'object') ? vm.iconnect_to_zoho : {};
      const zField = fieldsByName.get(fm.zoho_field);
      if (!zField) continue;
      const isPicklistLike = (zField.data_type || '').toLowerCase().includes('picklist');
      if (!isPicklistLike) continue;
      const idx = indexPicklistOptions(zField);
      if (idx.displaySet.size === 0 && idx.actualSet.size === 0) continue;

      // z2i keys = stored Zoho-side identifier on inbound
      for (const k of Object.keys(z2i)) {
        const c = classify(k, idx);
        if (c.match === 'display_match' || c.match === 'display_missing') continue;
        rowHasFinding = true;
        if (c.match === 'actual_match') summary.z2i_keys_actual_match += 1;
        if (c.match === 'orphan') summary.z2i_keys_orphan += 1;
        findings.push({
          tenant_id: tenantId,
          mapping_id: mappingRow.id,
          entity_type: mappingRow.entity_type,
          module: mappingRow.zoho_module,
          zoho_field: fm.zoho_field,
          iconnect_field: fm.iconnect_field,
          kind: 'z2i_key',
          stored_key: k,
          target: z2i[k] ?? null,
          match: c.match,
          proposed_rewrite: c.proposed
        });
      }

      // i2z targets = stored Zoho-side identifier on outbound
      for (const [k, v] of Object.entries(i2z)) {
        if (typeof v !== 'string' || v === '') continue;
        const c = classify(v, idx);
        if (c.match === 'display_match' || c.match === 'display_missing') continue;
        rowHasFinding = true;
        if (c.match === 'actual_match') summary.i2z_targets_actual_match += 1;
        if (c.match === 'orphan') summary.i2z_targets_orphan += 1;
        findings.push({
          tenant_id: tenantId,
          mapping_id: mappingRow.id,
          entity_type: mappingRow.entity_type,
          module: mappingRow.zoho_module,
          zoho_field: fm.zoho_field,
          iconnect_field: fm.iconnect_field,
          kind: 'i2z_target',
          stored_key: v,
          source_iconnect_value: k,
          match: c.match,
          proposed_rewrite: c.proposed
        });
      }
    }
    if (rowHasFinding) summary.rows_with_findings += 1;
  }

  return { summary, findings };
}

function printFindingsTable(findings) {
  if (findings.length === 0) {
    console.log('  (no findings)');
    return;
  }
  // Group by mapping_id for readability.
  const byMapping = new Map();
  for (const f of findings) {
    if (!byMapping.has(f.mapping_id)) byMapping.set(f.mapping_id, []);
    byMapping.get(f.mapping_id).push(f);
  }
  for (const [mid, rows] of byMapping) {
    const first = rows[0];
    console.log(`  Mapping ${first.entity_type}/${first.module} (${mid}):`);
    for (const f of rows) {
      const arrow = f.kind === 'z2i_key' ? 'Z→I key' : 'I→Z target';
      const proposed = f.proposed_rewrite
        ? `→ rewrite to "${f.proposed_rewrite}"`
        : (f.match === 'orphan' ? '→ ORPHAN (no live option matches; manual fix needed)' : '');
      const ctx = f.kind === 'z2i_key'
        ? `(maps to iConnect "${f.target ?? ''}")`
        : `(from iConnect "${f.source_iconnect_value ?? ''}")`;
      console.log(`    [${arrow}] ${f.zoho_field}: stored="${f.stored_key}" ${ctx}  ${proposed}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  if (!args.json) {
    console.log(`\n=== Audit value_map Zoho keys: display_value vs actual_value ===`);
    console.log(`tenant=${args.tenant || '(all)'}\n`);
  }

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
    rows_with_findings: 0,
    z2i_keys_actual_match: 0,
    z2i_keys_orphan: 0,
    i2z_targets_actual_match: 0,
    i2z_targets_orphan: 0
  };
  const allFindings = [];

  for (const tenantId of tenantIds) {
    if (!args.json) console.log(`\n--- tenant ${tenantId} ---`);
    const { summary, findings } = await processTenant(supabase, tenantId, fieldsCache);
    totals.tenants += 1;
    totals.mappings_scanned += summary.mappings_scanned;
    totals.rows_with_findings += summary.rows_with_findings;
    totals.z2i_keys_actual_match += summary.z2i_keys_actual_match;
    totals.z2i_keys_orphan += summary.z2i_keys_orphan;
    totals.i2z_targets_actual_match += summary.i2z_targets_actual_match;
    totals.i2z_targets_orphan += summary.i2z_targets_orphan;
    allFindings.push(...findings);
    if (!args.json) {
      printFindingsTable(findings);
      for (const sk of summary.skipped_modules) {
        console.log(`  [skip] ${sk.module}: ${sk.reason}`);
      }
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ totals, findings: allFindings }, null, 2));
    process.stdout.write('\n');
    return;
  }

  console.log(`\n=== Summary ===`);
  console.log(`  tenants processed:                     ${totals.tenants}`);
  console.log(`  mapping rows scanned:                  ${totals.mappings_scanned}`);
  console.log(`  rows with findings:                    ${totals.rows_with_findings}`);
  console.log(`  Z→I keys to rewrite (actual→display):  ${totals.z2i_keys_actual_match}`);
  console.log(`  Z→I keys orphaned (no live option):    ${totals.z2i_keys_orphan}`);
  console.log(`  I→Z targets to rewrite:                ${totals.i2z_targets_actual_match}`);
  console.log(`  I→Z targets orphaned:                  ${totals.i2z_targets_orphan}`);
  console.log(`\n  Read-only audit. Run scripts/migrate-picklist-value-map-actual-to-display.mjs to rewrite.\n`);
}

main().catch(err => {
  console.error('FATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
