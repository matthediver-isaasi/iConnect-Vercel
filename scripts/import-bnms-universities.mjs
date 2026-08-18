#!/usr/bin/env node
/**
 * Import BNMS universities with regions.
 *
 * Reads attached_assets/Student_universities_and_regions_*.xlsx and:
 *   1. Idempotently adds "University" to the organisation_type dropdown and any
 *      missing region values (including "Other/Not listed") to the region
 *      dropdown, de-duplicating a doubled "London" entry in region if present.
 *   2. Matches each row case-insensitively by name within the BNMS tenant,
 *      creating missing organisations.
 *   3. Upserts organization_preference_value rows for `region` (column B) and
 *      `organisation_type` = "University" on (organization_id, field_id).
 *
 * Usage:
 *   node scripts/import-bnms-universities.mjs            # DRY RUN (default)
 *   node scripts/import-bnms-universities.mjs --apply    # write to DB
 *
 * Environment: DEST_SUPABASE_URL + DEST_SUPABASE_KEY (DEST only — see replit.md).
 */

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const XLSX_FILE = path.join(
  REPO_ROOT,
  'attached_assets',
  'Student_universities_and_regions_1787063807281.xlsx',
);

const TENANT_ID        = 'ff2df806-b321-4254-b651-3af11fccf1db';
const ORG_TYPE_FIELD_ID = 'fd8dab3a-29ab-41f0-a002-d9cf822c51bf';
const REGION_FIELD_ID   = '91e58f93-f78f-465e-948b-c4808aecd89c';

const UNIVERSITY_TYPE_VALUE = 'University';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    console.error('ERROR: DEST_SUPABASE_URL and DEST_SUPABASE_KEY must both be set.');
    console.error('Do NOT use the bare SUPABASE_* vars — they point at the stale SOURCE project.');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Normalise a name for case-insensitive, whitespace-collapsed matching. */
function normName(s) {
  if (s == null) return '';
  // Normalise curly/smart apostrophes and quotes to straight, collapse whitespace.
  return String(s)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pad(s, n) {
  const str = s == null ? '' : String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function truncate(s, n) {
  const str = s == null ? '' : String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------------------
// Spreadsheet
// ---------------------------------------------------------------------------
function readSheet() {
  const wb = XLSX.readFile(XLSX_FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // grid[0] = ["Education establishment","Region"]
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const arr = grid[r];
    if (!arr) continue;
    const name   = arr[0] != null ? String(arr[0]).trim() : '';
    const region = arr[1] != null ? String(arr[1]).trim() : '';
    if (name) rows.push({ name, region });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apply = process.argv.includes('--apply');

  console.log('\n=== Import BNMS universities with regions ===');
  console.log(`tenant:  ${TENANT_ID}`);
  console.log(`mode:    ${apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}\n`);

  const supabase = getSupabase();

  // ── 1. Read spreadsheet ────────────────────────────────────────────────────
  const sheetRows = readSheet();
  console.log(`Spreadsheet: ${sheetRows.length} data row(s).`);

  const sheetRegions = [...new Set(sheetRows.map(r => r.region).filter(Boolean))].sort();
  console.log(`Regions in sheet: ${sheetRegions.join(', ')}\n`);

  // ── 2. Load current field options ─────────────────────────────────────────
  const { data: orgTypeField, error: otfErr } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, options')
    .eq('id', ORG_TYPE_FIELD_ID)
    .single();
  if (otfErr) { console.error('ERROR loading org_type field:', otfErr.message); process.exit(1); }

  const { data: regionField, error: rfErr } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type, options')
    .eq('id', REGION_FIELD_ID)
    .single();
  if (rfErr) { console.error('ERROR loading region field:', rfErr.message); process.exit(1); }

  console.log(`org_type field: "${orgTypeField.label}" (${orgTypeField.field_type})`);
  console.log(`region field:   "${regionField.label}" (${regionField.field_type})`);

  // ── 3. Compute option patches ──────────────────────────────────────────────
  // options is a JSON array of strings or objects; we'll treat it as string[]
  // or { value: string, label?: string }[] — normalise to strings for comparison.

  function parseOptions(raw) {
    if (!raw) return [];
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return []; }
    }
    if (!Array.isArray(raw)) return [];
    return raw.map(o => (typeof o === 'object' && o !== null ? (o.label ?? o.value ?? '') : String(o)));
  }

  const currentOrgTypeOptions = parseOptions(orgTypeField.options);
  const currentRegionOptions   = parseOptions(regionField.options);

  console.log(`\nCurrent org_type options (${currentOrgTypeOptions.length}): ${currentOrgTypeOptions.join(', ')}`);
  console.log(`Current region options   (${currentRegionOptions.length}): ${currentRegionOptions.join(', ')}`);

  // Org type: add "University" if missing (case-insensitive check)
  const orgTypeNorms = new Set(currentOrgTypeOptions.map(o => o.toLowerCase()));
  const orgTypeToAdd = orgTypeNorms.has(UNIVERSITY_TYPE_VALUE.toLowerCase()) ? [] : [UNIVERSITY_TYPE_VALUE];

  // Region: de-dup "London" (keep first occurrence), add missing sheet values
  const regionDeduped = [];
  const seenRegionNorms = new Set();
  for (const opt of currentRegionOptions) {
    const n = opt.toLowerCase();
    if (!seenRegionNorms.has(n)) {
      regionDeduped.push(opt);
      seenRegionNorms.add(n);
    } else {
      console.log(`  [region] Removing duplicate option: "${opt}"`);
    }
  }
  const regionToAdd = [];
  for (const r of sheetRegions) {
    if (!seenRegionNorms.has(r.toLowerCase())) {
      regionToAdd.push(r);
      seenRegionNorms.add(r.toLowerCase());
    }
  }

  const newOrgTypeOptions = [...currentOrgTypeOptions, ...orgTypeToAdd];
  const newRegionOptions  = [...regionDeduped, ...regionToAdd];

  const orgTypeChanged = orgTypeToAdd.length > 0;
  const regionChanged  = regionDeduped.length !== currentRegionOptions.length || regionToAdd.length > 0;

  console.log('\n--- Dropdown option changes ---');
  if (!orgTypeChanged && !regionChanged) {
    console.log('  No option changes needed.');
  } else {
    if (orgTypeToAdd.length > 0)
      console.log(`  org_type: adding "${orgTypeToAdd.join('", "')}"`);
    else
      console.log('  org_type: no changes needed');

    if (regionDeduped.length !== currentRegionOptions.length)
      console.log(`  region: removed ${currentRegionOptions.length - regionDeduped.length} duplicate(s)`);
    if (regionToAdd.length > 0)
      console.log(`  region: adding "${regionToAdd.join('", "')}"`);
    if (!regionChanged)
      console.log('  region: no changes needed');
  }

  // ── 4. Load existing BNMS orgs ─────────────────────────────────────────────
  const { data: existingOrgs, error: orgsErr } = await supabase
    .from('organization')
    .select('id, name')
    .eq('tenant_id', TENANT_ID);
  if (orgsErr) { console.error('ERROR loading orgs:', orgsErr.message); process.exit(1); }

  const existingByNorm = new Map(); // normName -> org
  for (const o of existingOrgs || []) {
    existingByNorm.set(normName(o.name), o);
  }
  console.log(`\nExisting BNMS organisations: ${existingOrgs.length}`);

  // ── 5. Plan per-row actions ────────────────────────────────────────────────
  const plans = []; // { name, region, action: 'create'|'update', existingId? }

  for (const row of sheetRows) {
    const key = normName(row.name);
    const existing = existingByNorm.get(key);
    plans.push({
      name:       row.name,
      region:     row.region,
      action:     existing ? 'update' : 'create',
      existingId: existing ? existing.id : null,
    });
  }

  const creates = plans.filter(p => p.action === 'create');
  const updates = plans.filter(p => p.action === 'update');

  console.log(`\n--- Per-org plan ---`);
  console.log(`  To CREATE: ${creates.length}`);
  if (creates.length > 0) {
    creates.forEach(p => console.log(`    + ${p.name} (${p.region})`));
  }
  console.log(`  To UPDATE: ${updates.length}`);
  if (updates.length > 0) {
    updates.forEach(p => console.log(`    ~ ${truncate(p.name, 55)} (${p.region})`));
  }

  // ── 6. Dry-run exit ────────────────────────────────────────────────────────
  if (!apply) {
    console.log('\n=== DRY RUN summary ===');
    console.log(`  Sheet rows:            ${sheetRows.length}`);
    console.log(`  Orgs to CREATE:        ${creates.length}`);
    console.log(`  Orgs to UPDATE:        ${updates.length}`);
    console.log(`  org_type opts to add:  ${orgTypeToAdd.length}`);
    console.log(`  region opts to add:    ${regionToAdd.length}`);
    console.log(`  region dups to remove: ${currentRegionOptions.length - regionDeduped.length}`);
    console.log('\n  No rows were modified. Re-run with --apply to write.\n');
    return;
  }

  // ── 7. Apply dropdown option changes ──────────────────────────────────────
  console.log('\n--- Applying dropdown option changes ---');

  if (orgTypeChanged) {
    const { error } = await supabase
      .from('preference_field')
      .update({ options: newOrgTypeOptions })
      .eq('id', ORG_TYPE_FIELD_ID);
    if (error) { console.error('ERROR updating org_type options:', error.message); process.exit(1); }
    console.log(`  org_type options updated (${newOrgTypeOptions.length} total)`);
  }

  if (regionChanged) {
    const { error } = await supabase
      .from('preference_field')
      .update({ options: newRegionOptions })
      .eq('id', REGION_FIELD_ID);
    if (error) { console.error('ERROR updating region options:', error.message); process.exit(1); }
    console.log(`  region options updated (${newRegionOptions.length} total)`);
  }

  if (!orgTypeChanged && !regionChanged) {
    console.log('  No dropdown changes needed.');
  }

  // ── 8. Create missing orgs ─────────────────────────────────────────────────
  console.log('\n--- Creating organisations ---');
  let createOk = 0, createFail = 0;
  const createdIds = new Map(); // name -> id

  for (const p of creates) {
    const { data, error } = await supabase
      .from('organization')
      .insert({ name: p.name, tenant_id: TENANT_ID })
      .select('id')
      .single();
    if (error) {
      console.error(`  ERROR creating "${p.name}": ${error.message}`);
      createFail++;
    } else {
      createdIds.set(p.name, data.id);
      console.log(`  + Created: ${p.name} -> ${data.id}`);
      createOk++;
      // Add to existingByNorm so pref-write below can find it.
      existingByNorm.set(normName(p.name), { id: data.id, name: p.name });
    }
  }

  // ── 9. Upsert preference values ────────────────────────────────────────────
  // Load existing pref values for these orgs + fields.
  console.log('\n--- Upserting preference values ---');

  // Gather all org ids we will touch.
  const allOrgIds = plans
    .map(p => p.existingId ?? createdIds.get(p.name))
    .filter(Boolean);

  // Load existing pref values.
  const existingPrefs = new Map(); // `${orgId}::${fieldId}` -> { id, value }
  if (allOrgIds.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < allOrgIds.length; i += CHUNK) {
      const slice = allOrgIds.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from('organization_preference_value')
        .select('id, organization_id, field_id, value')
        .in('organization_id', slice)
        .in('field_id', [ORG_TYPE_FIELD_ID, REGION_FIELD_ID]);
      if (error) { console.error('ERROR loading pref values:', error.message); process.exit(1); }
      for (const row of data || []) {
        existingPrefs.set(`${row.organization_id}::${row.field_id}`, { id: row.id, value: row.value });
      }
    }
  }

  let prefOk = 0, prefFail = 0, prefSkipped = 0;

  for (const p of plans) {
    const orgId = p.existingId ?? createdIds.get(p.name);
    if (!orgId) {
      // org creation failed — skip
      prefSkipped++;
      continue;
    }

    // Upsert region
    if (p.region) {
      const key = `${orgId}::${REGION_FIELD_ID}`;
      const existing = existingPrefs.get(key);
      if (existing && existing.value === p.region) {
        prefSkipped++;
      } else if (existing) {
        const { error } = await supabase
          .from('organization_preference_value')
          .update({ value: p.region })
          .eq('id', existing.id);
        if (error) {
          console.error(`  ERROR updating region for "${p.name}": ${error.message}`);
          prefFail++;
        } else {
          prefOk++;
        }
      } else {
        const { error } = await supabase
          .from('organization_preference_value')
          .insert({ organization_id: orgId, field_id: REGION_FIELD_ID, value: p.region });
        if (error) {
          console.error(`  ERROR inserting region for "${p.name}": ${error.message}`);
          prefFail++;
        } else {
          prefOk++;
        }
      }
    }

    // Upsert organisation_type = "University"
    {
      const key = `${orgId}::${ORG_TYPE_FIELD_ID}`;
      const existing = existingPrefs.get(key);
      if (existing && existing.value === UNIVERSITY_TYPE_VALUE) {
        prefSkipped++;
      } else if (existing) {
        const { error } = await supabase
          .from('organization_preference_value')
          .update({ value: UNIVERSITY_TYPE_VALUE })
          .eq('id', existing.id);
        if (error) {
          console.error(`  ERROR updating org_type for "${p.name}": ${error.message}`);
          prefFail++;
        } else {
          prefOk++;
        }
      } else {
        const { error } = await supabase
          .from('organization_preference_value')
          .insert({ organization_id: orgId, field_id: ORG_TYPE_FIELD_ID, value: UNIVERSITY_TYPE_VALUE });
        if (error) {
          console.error(`  ERROR inserting org_type for "${p.name}": ${error.message}`);
          prefFail++;
        } else {
          prefOk++;
        }
      }
    }
  }

  // ── 10. Final summary ──────────────────────────────────────────────────────
  console.log('\n=== APPLY summary ===');
  console.log(`  Organisations created:   ${createOk}${createFail ? `  (${createFail} FAILED)` : ''}`);
  console.log(`  Pref values written:     ${prefOk}${prefFail ? `  (${prefFail} FAILED)` : ''}`);
  console.log(`  Pref values unchanged:   ${prefSkipped}`);
  if (createFail + prefFail === 0) {
    console.log('\n  All writes succeeded.\n');
  } else {
    console.log('\n  Some writes FAILED — review errors above.\n');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
