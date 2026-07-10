#!/usr/bin/env node
/**
 * Task #2585 — Import "Number of teachers" values for GSF (Global Schools
 * Forum) organisations.
 *
 * The sheet is keyed by the organisation `id` (uuid), so every row targets an
 * EXISTING organisation — this is an UPDATE, never an insert. It follows the
 * established idempotent-script convention (modelled on
 * scripts/update-organisations-from-zoho.mjs): DRY RUN by default, only writing
 * when an explicit `--apply` flag is passed.
 *
 * What it does:
 *   1. Parses the xlsx (columns: "Org id", "Number of teachers").
 *   2. Loads every referenced organisation and hard-fails if any id is missing
 *      or belongs to a tenant other than `gsf`.
 *   3. Upserts the `number_of_teachers` custom field
 *      (preference_field id f2435ba9-9e15-4b02-bf47-c1f0aacf8ff6) into
 *      `organization_preference_value`, keyed on the unique
 *      (organization_id, field_id) constraint. The number is stored as a plain
 *      scalar string (NOT JSON-encoded), matching the convention in
 *      scripts/update-organisations-from-zoho.mjs.
 *   4. Skips blank cells (never overwrites an existing value with empty).
 *   5. Prints a per-org old -> new diff and a summary. Writes nothing unless
 *      `--apply` is passed. A second `--apply` run reports zero changes.
 *
 * Usage:
 *   node scripts/import-gsf-number-of-teachers.mjs                 # DRY RUN
 *   node scripts/import-gsf-number-of-teachers.mjs --dry-run       # DRY RUN (explicit)
 *   node scripts/import-gsf-number-of-teachers.mjs --apply         # perform writes
 *   node scripts/import-gsf-number-of-teachers.mjs --file=<path>   # override spreadsheet path
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
  'Import_into_iConnect_number_of_teachers_1783680130431.xlsx',
);

// Verified facts (confirmed against the DEST DB — see task-2585.md).
const GSF_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const FIELD_ID = 'f2435ba9-9e15-4b02-bf47-c1f0aacf8ff6'; // number_of_teachers

const KEY_COLUMN = 'Org id';
const VALUE_COLUMN = 'Number of teachers';

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
      console.log('Usage: node scripts/import-gsf-number-of-teachers.mjs [--dry-run | --apply] [--file=<path>]');
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
  // "Database connection" / memory workspace-db-targets), so a fallback here
  // risks writing to the wrong database.
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  if (!url || !key) {
    console.error('ERROR: DEST_SUPABASE_URL and DEST_SUPABASE_KEY must both be set (see replit.md "Database connection").');
    console.error('This script writes to the destination/prod project only; the bare SUPABASE_* names are NOT used because they point at the stale legacy SOURCE project here.');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------
function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

// Store the number as a plain scalar string (do NOT JSON-encode) — the
// convention documented in scripts/update-organisations-from-zoho.mjs for
// single-value number fields.
function normaliseNumber(v) {
  const n = Number(String(v).trim());
  if (Number.isFinite(n)) return String(n);
  return String(v).trim();
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  console.log('\n=== Import number_of_teachers for GSF organisations ===');
  console.log(`file:     ${args.file}`);
  console.log(`mode:     ${args.apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log(`tenant:   gsf (${GSF_TENANT_ID})`);
  console.log(`field:    number_of_teachers (${FIELD_ID})\n`);

  // 1. Parse the spreadsheet.
  const { header, rows } = readSheet(args.file);
  console.log(`Parsed ${rows.length} data row(s); columns: ${header.join(', ')}`);

  if (!header.includes(KEY_COLUMN)) {
    console.error(`ERROR: spreadsheet is missing the "${KEY_COLUMN}" column. Aborting.`);
    process.exit(1);
  }
  if (!header.includes(VALUE_COLUMN)) {
    console.error(`ERROR: spreadsheet is missing the "${VALUE_COLUMN}" column. Aborting.`);
    process.exit(1);
  }

  // Build id -> value, keying by org id (last occurrence wins on duplicates).
  const valueById = new Map();
  let blankSkips = 0;
  let missingKeyRows = 0;
  for (const row of rows) {
    if (isBlank(row[KEY_COLUMN])) { missingKeyRows++; continue; }
    const id = String(row[KEY_COLUMN]).trim();
    const raw = row[VALUE_COLUMN];
    if (isBlank(raw)) { blankSkips++; continue; }
    valueById.set(id, normaliseNumber(raw));
  }
  if (missingKeyRows > 0) {
    console.error(`ERROR: ${missingKeyRows} row(s) have no "${KEY_COLUMN}" value. Cannot match. Aborting.`);
    process.exit(1);
  }
  const ids = [...valueById.keys()];
  console.log(`Rows with a value: ${ids.length}; blank cells skipped: ${blankSkips}\n`);

  // 2. Load organisations by id, hard-fail on missing or wrong-tenant.
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
    if (missingIds.length > 25) console.error(`  ...and ${missingIds.length - 25} more`);
    process.exit(1);
  }

  const wrongTenant = [...orgsById.values()].filter((o) => o.tenant_id !== GSF_TENANT_ID);
  if (wrongTenant.length > 0) {
    console.error(`\nERROR: ${wrongTenant.length} organisation(s) do not belong to the gsf tenant. Aborting (no writes).`);
    wrongTenant.slice(0, 25).forEach((o) => console.error(`  ${o.id} (tenant ${o.tenant_id}) ${o.name || ''}`));
    process.exit(1);
  }
  console.log(`Matched ${orgsById.size}/${ids.length} organisations, all in the gsf tenant.\n`);

  // 3. Pre-load existing preference values for the number_of_teachers field.
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
          // A stable ORDER BY is REQUIRED with ranged pagination, otherwise
          // pages overlap and skip rows (see replit.md memory
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

  // 4. Compute the per-org plan.
  const plans = []; // { org, old, new }
  for (const id of ids) {
    const org = orgsById.get(id);
    const stored = valueById.get(id);
    const existing = existingPref.get(id) || null;
    const oldVal = existing ? (existing.value == null ? '' : String(existing.value)) : '';
    if (oldVal === stored) continue;
    plans.push({ org, old: oldVal, new: stored });
  }

  // 5. Print per-org diffs.
  console.log('--- Proposed changes (per organisation) ---');
  if (plans.length === 0) {
    console.log('  No changes — every org already has the spreadsheet value.');
  }
  for (const p of plans) {
    console.log(
      `  ${p.org.id}  ${pad(truncate(p.org.name || '(unnamed)', 40), 40)} ` +
      `${pad(p.old || '(empty)', 12)} ->  ${p.new}`,
    );
  }

  // 6. Summary.
  const printSummary = (heading) => {
    console.log(`\n=== ${heading} ===`);
    console.log(`  Orgs in sheet (with value): ${ids.length}`);
    console.log(`  Orgs matched in DB:         ${orgsById.size}`);
    console.log(`  Orgs with changes:          ${plans.length}`);
    console.log(`  Blank cells skipped:        ${blankSkips}`);
  };

  if (!args.apply) {
    printSummary('DRY RUN summary');
    console.log('\n  No rows were modified. Re-run with --apply to perform the updates.\n');
    return;
  }

  // 7. Apply — one idempotent, batched upsert keyed on the unique
  // (organization_id, field_id) constraint.
  console.log('\n--- Applying updates ---');
  const upsertRows = plans.map((p) => ({
    organization_id: p.org.id,
    field_id: FIELD_ID,
    value: p.new,
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
    console.log('\n  Failures:');
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
