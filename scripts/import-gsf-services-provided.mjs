#!/usr/bin/env node
/**
 * Import "Services provided" multi-select values for GSF (Global Schools
 * Forum) organisations, modelled on scripts/import-gsf-number-of-teachers.mjs.
 *
 * What it does:
 *   1. Ensures the option "Skilling and work readiness" exists on the
 *      services_provided preference_field (inserted alphabetically, before
 *      "System strengthening"; "Other" stays last). Idempotent.
 *   2. Parses the xlsx (columns: "Org id", "Services provided"), splitting
 *      column 2 on commas and trimming each value.
 *   3. Hard-fails if any org id is missing, belongs to a tenant other than
 *      gsf, or any value is not a valid field option.
 *   4. Upserts JSON-stringified arrays into organization_preference_value,
 *      keyed on the unique (organization_id, field_id) constraint (the
 *      MULTI_FIELD_TYPES convention from update-organisations-from-zoho.mjs).
 *   5. Skips orgs whose existing value already matches (order-insensitive).
 *      DRY RUN by default; writes only with --apply. Re-running --apply
 *      reports zero changes.
 *
 * Usage:
 *   node scripts/import-gsf-services-provided.mjs                 # DRY RUN
 *   node scripts/import-gsf-services-provided.mjs --apply         # perform writes
 *   node scripts/import-gsf-services-provided.mjs --file=<path>   # override spreadsheet path
 *
 * Environment (this workspace): DEST_SUPABASE_URL + DEST_SUPABASE_KEY.
 * See replit.md "Database connection".
 */

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_FILE = path.join(
  repoRoot,
  'attached_assets',
  'Import_into_iConnect_services_provided_1784013168343.xlsx',
);

// Verified facts (confirmed against the DEST DB — see task-2789.md).
const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const FIELD_ID = '0d27775a-579b-49ac-8b63-9ebdcb2a1ffe'; // services_provided

const NEW_OPTION = 'Skilling and work readiness';
// Insert the new option immediately before this existing option (its
// alphabetical position; "Other" stays last).
const INSERT_BEFORE = 'System strengthening';

const KEY_COLUMN = 'Org id';
const VALUE_COLUMN = 'Services provided';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { apply: false, file: DEFAULT_FILE };
  let explicitDryRun = false;
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a.startsWith('--file=')) args.file = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/import-gsf-services-provided.mjs [--dry-run | --apply] [--file=<path>]');
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
  // DEST_* ONLY. Do NOT fall back to the bare SUPABASE_* names: in this
  // workspace those resolve to the stale legacy SOURCE project (see replit.md
  // "Database connection" / memory workspace-db-targets).
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    console.error('ERROR: DEST_SUPABASE_URL and DEST_SUPABASE_KEY must both be set (see replit.md "Database connection").');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function parseServices(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// Order-insensitive comparison of an existing stored value (JSON array string
// or empty) against the desired array.
function sameSet(existingRaw, desired) {
  let existing = [];
  if (!isBlank(existingRaw)) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (Array.isArray(parsed)) existing = parsed.map((s) => String(s));
      else existing = [String(existingRaw)];
    } catch {
      existing = [String(existingRaw)];
    }
  }
  if (existing.length !== desired.length) return false;
  const a = [...existing].sort();
  const b = [...desired].sort();
  return a.every((v, i) => v === b[i]);
}

function pad(s, n) {
  const str = s == null ? '' : String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function truncate(s, n) {
  const str = s == null ? '' : String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function readSheet(file) {
  const wb = XLSX.readFile(file, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const header = grid[0].map((h) => (h == null ? '' : String(h).trim()));
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const arr = grid[r];
    if (!arr) continue;
    const obj = {};
    let anyValue = false;
    header.forEach((h, c) => {
      obj[h] = arr[c] === undefined ? null : arr[c];
      if (!isBlank(obj[h])) anyValue = true;
    });
    if (anyValue) rows.push(obj);
  }
  return { header, rows };
}

// ---------------------------------------------------------------------------
// Step 1: ensure the new field option exists (idempotent)
// ---------------------------------------------------------------------------
async function ensureOption(supabase, apply) {
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, options')
    .eq('id', FIELD_ID)
    .single();
  if (error) throw new Error(`preference_field load failed: ${error.message}`);

  const options = Array.isArray(data.options) ? data.options : [];
  const labels = options.map((o) => o.label);
  if (labels.includes(NEW_OPTION)) {
    console.log(`Option "${NEW_OPTION}" already present on the field — no option change needed.`);
    return labels;
  }

  const idx = labels.indexOf(INSERT_BEFORE);
  const insertAt = idx >= 0 ? idx : options.length;
  const updated = [
    ...options.slice(0, insertAt),
    { label: NEW_OPTION, value: NEW_OPTION },
    ...options.slice(insertAt),
  ];

  if (!apply) {
    console.log(`[dry run] Would add option "${NEW_OPTION}" at position ${insertAt} (before "${INSERT_BEFORE}").`);
  } else {
    const { error: upErr } = await supabase
      .from('preference_field')
      .update({ options: updated })
      .eq('id', FIELD_ID);
    if (upErr) throw new Error(`preference_field option update failed: ${upErr.message}`);
    console.log(`Added option "${NEW_OPTION}" at position ${insertAt} (before "${INSERT_BEFORE}").`);
  }
  return updated.map((o) => o.label);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  console.log('\n=== Import services_provided for GSF organisations ===');
  console.log(`file:     ${args.file}`);
  console.log(`mode:     ${args.apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log(`tenant:   gsf (${GSF_TENANT_ID})`);
  console.log(`field:    services_provided (${FIELD_ID})\n`);

  // 1. Ensure the new option exists (returns the effective option label set).
  const optionLabels = await ensureOption(supabase, args.apply);
  const validValues = new Set(optionLabels);
  // In dry-run mode the option may not be persisted yet, but the returned set
  // already includes it so validation reflects the post-apply state.
  if (!validValues.has(NEW_OPTION)) validValues.add(NEW_OPTION);

  // 2. Parse the spreadsheet.
  const { header, rows } = readSheet(args.file);
  console.log(`\nParsed ${rows.length} data row(s); columns: ${header.join(', ')}`);
  for (const col of [KEY_COLUMN, VALUE_COLUMN]) {
    if (!header.includes(col)) {
      console.error(`ERROR: spreadsheet is missing the "${col}" column. Aborting.`);
      process.exit(1);
    }
  }

  const valueById = new Map(); // orgId -> string[]
  let blankSkips = 0;
  let missingKeyRows = 0;
  for (const row of rows) {
    if (isBlank(row[KEY_COLUMN])) { missingKeyRows++; continue; }
    const id = String(row[KEY_COLUMN]).trim();
    const raw = row[VALUE_COLUMN];
    if (isBlank(raw)) { blankSkips++; continue; }
    valueById.set(id, parseServices(raw));
  }
  if (missingKeyRows > 0) {
    console.error(`ERROR: ${missingKeyRows} row(s) have no "${KEY_COLUMN}" value. Aborting.`);
    process.exit(1);
  }
  const ids = [...valueById.keys()];
  console.log(`Rows with a value: ${ids.length}; blank cells skipped: ${blankSkips}`);

  // 3. Validate every value against the field options — hard-fail on mismatch.
  const badValues = [];
  for (const [id, vals] of valueById) {
    for (const v of vals) {
      if (!validValues.has(v)) badValues.push({ id, value: v });
    }
  }
  if (badValues.length > 0) {
    console.error(`\nERROR: ${badValues.length} value(s) do not match any field option. Aborting (no writes).`);
    badValues.slice(0, 25).forEach((b) => console.error(`  ${b.id}: "${b.value}"`));
    process.exit(1);
  }
  console.log('All spreadsheet values match field options.\n');

  // 4. Load organisations by id, hard-fail on missing or wrong-tenant.
  const orgsById = new Map();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('organization')
      .select('id, tenant_id, name')
      .in('id', slice);
    if (error) throw new Error(`organization load failed: ${error.message}`);
    for (const o of data || []) orgsById.set(o.id, o);
  }

  const missingIds = ids.filter((id) => !orgsById.has(id));
  if (missingIds.length > 0) {
    console.error(`\nERROR: ${missingIds.length} id(s) in the sheet do not exist in the DB. Aborting (no writes).`);
    missingIds.slice(0, 25).forEach((id) => console.error(`  missing: ${id}`));
    process.exit(1);
  }
  const wrongTenant = [...orgsById.values()].filter((o) => o.tenant_id !== GSF_TENANT_ID);
  if (wrongTenant.length > 0) {
    console.error(`\nERROR: ${wrongTenant.length} organisation(s) do not belong to the gsf tenant. Aborting (no writes).`);
    wrongTenant.slice(0, 25).forEach((o) => console.error(`  ${o.id} (tenant ${o.tenant_id}) ${o.name || ''}`));
    process.exit(1);
  }
  console.log(`Matched ${orgsById.size}/${ids.length} organisations, all in the gsf tenant.\n`);

  // 5. Pre-load existing preference values for the field.
  const existingPref = new Map(); // orgId -> { id, value }
  {
    const PAGE = 1000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('organization_preference_value')
          .select('id, organization_id, value')
          .in('organization_id', slice)
          .eq('field_id', FIELD_ID)
          // Stable ORDER BY is REQUIRED with ranged pagination (see memory
          // postgrest-pagination-order).
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`organization_preference_value load failed: ${error.message}`);
        for (const r of data || []) {
          existingPref.set(r.organization_id, { id: r.id, value: r.value });
        }
        if (!data || data.length < PAGE) break;
      }
    }
  }

  // 6. Compute the per-org plan (skip order-insensitive matches).
  const plans = []; // { org, old, newArr }
  let unchanged = 0;
  for (const id of ids) {
    const org = orgsById.get(id);
    const desired = valueById.get(id);
    const existing = existingPref.get(id) || null;
    const oldRaw = existing ? existing.value : '';
    if (sameSet(oldRaw, desired)) { unchanged++; continue; }
    plans.push({ org, old: oldRaw == null ? '' : String(oldRaw), newArr: desired });
  }

  console.log('--- Proposed changes (per organisation) ---');
  if (plans.length === 0) {
    console.log('  No changes — every org already has the spreadsheet value.');
  }
  for (const p of plans) {
    console.log(
      `  ${p.org.id}  ${pad(truncate(p.org.name || '(unnamed)', 40), 40)} ` +
      `${pad(truncate(p.old || '(empty)', 20), 20)} ->  ${p.newArr.join(' | ')}`,
    );
  }

  const printSummary = (heading) => {
    console.log(`\n=== ${heading} ===`);
    console.log(`  Orgs in sheet (with value): ${ids.length}`);
    console.log(`  Orgs matched in DB:         ${orgsById.size}`);
    console.log(`  Orgs with changes:          ${plans.length}`);
    console.log(`  Orgs already matching:      ${unchanged}`);
    console.log(`  Blank cells skipped:        ${blankSkips}`);
  };

  if (!args.apply) {
    printSummary('DRY RUN summary');
    console.log('\n  No rows were modified. Re-run with --apply to perform the updates.\n');
    return;
  }

  // 7. Apply — batched upsert keyed on (organization_id, field_id).
  console.log('\n--- Applying updates ---');
  const upsertRows = plans.map((p) => ({
    organization_id: p.org.id,
    field_id: FIELD_ID,
    value: JSON.stringify(p.newArr),
    updated_at: new Date().toISOString(),
  }));

  const applied = { prefWrites: 0, prefBatches: 0, failures: [] };
  const BATCH = 500;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const batch = upsertRows.slice(i, i + BATCH);
    const { error } = await supabase
      .from('organization_preference_value')
      .upsert(batch, { onConflict: 'organization_id,field_id' });
    if (error) {
      applied.failures.push({ scope: `pref-batch@${i}`, error: error.message });
      console.log(`    [error] pref batch ${i}-${i + batch.length}: ${error.message}`);
    } else {
      applied.prefWrites += batch.length;
      applied.prefBatches++;
    }
  }

  printSummary('APPLY summary');
  console.log(`  Pref values written:        ${applied.prefWrites} (${applied.prefBatches} batch upsert(s))`);
  console.log(`  Failures:                   ${applied.failures.length}`);
  if (applied.failures.length > 0) {
    applied.failures.forEach((f) => console.log(`    ${f.scope}: ${f.error}`));
    process.exitCode = 1;
  }
  console.log('\n  Done. Re-run with --apply to confirm idempotency (should report zero changes).\n');
}

main().catch((err) => {
  console.error('\nFATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
