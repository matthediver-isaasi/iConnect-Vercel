#!/usr/bin/env node
/**
 * Task #2385 — Update existing organisation records from a Zoho export
 * spreadsheet.
 *
 * The sheet is keyed by the organisation `id` (uuid), so every row targets an
 * EXISTING organisation — this is an UPDATE, never an insert. It follows the
 * established idempotent-script convention: DRY RUN by default, only writing
 * when an explicit `--apply` flag is passed.
 *
 * What it does:
 *   1. Parses the xlsx (with Excel date-serial handling for `Year established`).
 *   2. Resolves the target tenant from the organisation ids themselves and
 *      hard-fails if any id is missing or belongs to a different tenant.
 *   3. Builds a column -> target map:
 *        - Core `organization` columns: Website -> website_url, Status -> status.
 *        - `Organisation overview` -> configurable (custom field by default, or
 *          core `description` with --overview=description).
 *        - Everything else -> a custom organisation preference field matched by
 *          LABEL within the tenant's `organization`-scoped `preference_field`
 *          rows. Unresolved columns are reported and skipped.
 *   4. Computes a per-organisation diff (old -> new) for every field that would
 *      change, skipping blank cells (never overwrites with an empty string) and
 *      encoding multi-value / date / number cells to match how the target field
 *      stores its value.
 *   5. Prints the mapping, per-org diffs and a summary. Writes nothing unless
 *      `--apply` is passed. A second `--apply` run reports zero changes.
 *
 * Storage conventions (verified against the destination DB):
 *   - Multi-value fields (picklist / countries / list / multiselect / checkbox)
 *     store a JSON-encoded array string, e.g. `["Primary","Secondary"]`.
 *   - Single-value fields store the plain value string, e.g. `Kenya`, `52`,
 *     `2008-01-01`. (Do NOT JSON-encode single scalars.)
 *
 * Usage:
 *   node scripts/update-organisations-from-zoho.mjs                    # DRY RUN
 *   node scripts/update-organisations-from-zoho.mjs --dry-run          # DRY RUN (explicit)
 *   node scripts/update-organisations-from-zoho.mjs --apply            # perform writes
 *   node scripts/update-organisations-from-zoho.mjs --overview=description   # write overview to core description
 *   node scripts/update-organisations-from-zoho.mjs --file=<path.xlsx> # override spreadsheet path
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
  'Organisations_data_to_import-update_in_iConnect_from_Zoho_06._1783356821285.xlsx',
);

const KEY_COLUMN = 'id';

// Spreadsheet header -> core organization column.
const CORE_COLUMN_MAP = {
  Website: 'website_url',
  Status: 'status',
};

// The single ambiguous column, resolved via --overview.
const OVERVIEW_COLUMN = 'Organisation overview';
const OVERVIEW_CUSTOM_FIELD_LABEL = 'Organisation overview';

// Preference field types whose value is a JSON-encoded array of the
// semicolon-delimited cell parts. Everything else is a single scalar.
const MULTI_FIELD_TYPES = new Set([
  'picklist', 'countries', 'list', 'multiselect', 'multi_select', 'checkbox',
]);
const DATE_FIELD_TYPES = new Set(['date']);
const NUMBER_FIELD_TYPES = new Set(['number', 'decimal']);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { apply: false, overview: 'custom', file: DEFAULT_FILE, allowUnresolved: false };
  let explicitDryRun = false;
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--allow-unresolved') args.allowUnresolved = true;
    else if (a.startsWith('--overview=')) args.overview = a.split('=')[1];
    else if (a.startsWith('--file=')) args.file = a.split('=')[1];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/update-organisations-from-zoho.mjs [--dry-run | --apply] [--overview=custom|description] [--allow-unresolved] [--file=<path>]');
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
  if (!['custom', 'description'].includes(args.overview)) {
    console.error(`Error: --overview must be "custom" or "description" (got "${args.overview}").`);
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
// Value normalisation / encoding
// ---------------------------------------------------------------------------
const norm = (s) => (s == null ? '' : String(s)).trim().toLowerCase();

function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

// Format an Excel date cell (Date object under cellDates, or a raw serial
// number) to the canonical YYYY-MM-DD string used by date preference fields.
function formatDateCell(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && isFinite(v)) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    }
  }
  // Fall back to a leading date-like prefix if the cell was already text.
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function normaliseNumber(v) {
  const n = Number(String(v).trim());
  if (Number.isFinite(n)) return String(n);
  return String(v).trim();
}

// Encode a raw spreadsheet cell into the exact string that should live in the
// target's storage, given the field type. Returns { display, stored } where
// `display` is a human-readable form for the dry-run diff and `stored` is the
// literal value written to the DB.
function encodeForField(rawValue, fieldType) {
  const t = (fieldType || '').toLowerCase();

  // A spreadsheet date cell (read with cellDates:true yields a Date object)
  // must ALWAYS be stored as YYYY-MM-DD — never a raw serial or a JS Date
  // string — regardless of how the target field happens to be typed in
  // preference_field. This guards `Year established` even if its field were
  // mistyped as text/number.
  if (rawValue instanceof Date) {
    const d = formatDateCell(rawValue);
    return { display: d, stored: d };
  }

  if (MULTI_FIELD_TYPES.has(t)) {
    const parts = String(rawValue)
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    const stored = JSON.stringify(parts);
    return { display: parts.join(' | '), stored };
  }

  if (DATE_FIELD_TYPES.has(t)) {
    const d = formatDateCell(rawValue);
    return { display: d, stored: d };
  }

  if (NUMBER_FIELD_TYPES.has(t)) {
    const n = normaliseNumber(rawValue);
    return { display: n, stored: n };
  }

  const s = String(rawValue).trim();
  return { display: s, stored: s };
}

// Core columns are always stored as the trimmed string.
function encodeCore(rawValue) {
  const s = String(rawValue).trim();
  return { display: s, stored: s };
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

  console.log('\n=== Update organisations from Zoho spreadsheet ===');
  console.log(`file:     ${args.file}`);
  console.log(`mode:     ${args.apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`);
  console.log(`overview: -> ${args.overview === 'custom' ? `custom field "${OVERVIEW_CUSTOM_FIELD_LABEL}"` : 'core column "description"'}\n`);

  // 1. Parse the spreadsheet.
  const { header, rows } = readSheet(args.file);
  console.log(`Parsed ${rows.length} data row(s); ${header.length} columns.`);

  const idsInSheet = rows.map((r) => (isBlank(r[KEY_COLUMN]) ? null : String(r[KEY_COLUMN]).trim()));
  const missingKeyRows = idsInSheet.filter((v) => v === null).length;
  if (missingKeyRows > 0) {
    console.error(`ERROR: ${missingKeyRows} row(s) have no "${KEY_COLUMN}" value. Cannot match. Aborting.`);
    process.exit(1);
  }
  const ids = [...new Set(idsInSheet)];
  if (ids.length !== idsInSheet.length) {
    console.log(`Note: sheet contains ${idsInSheet.length - ids.length} duplicate id(s); last occurrence wins.`);
  }

  // 2. Load organisations by id, resolve tenant, hard-fail on missing.
  const orgsById = new Map();
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('organization')
      .select('id, tenant_id, name, website_url, status, description')
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

  const byTenant = new Map();
  for (const o of orgsById.values()) {
    if (!byTenant.has(o.tenant_id)) byTenant.set(o.tenant_id, []);
    byTenant.get(o.tenant_id).push(o.id);
  }
  if (byTenant.size !== 1) {
    console.error(`\nERROR: matched organisations span ${byTenant.size} tenants. This importer requires a single tenant. Aborting (no writes).`);
    for (const [tid, orgIds] of byTenant) {
      console.error(`  tenant ${tid}: ${orgIds.length} org(s)`);
      orgIds.slice(0, 25).forEach((id) => console.error(`    - ${id}`));
      if (orgIds.length > 25) console.error(`    ...and ${orgIds.length - 25} more`);
    }
    process.exit(1);
  }
  const tenantId = [...byTenant.keys()][0];
  console.log(`Matched ${orgsById.size}/${ids.length} organisations. Tenant: ${tenantId}\n`);

  // 3. Load org-scoped preference fields for the tenant and build the map.
  const { data: fields, error: fErr } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization');
  if (fErr) throw new Error(`preference_field load failed: ${fErr.message}`);
  const fieldByLabel = new Map();
  for (const f of fields || []) {
    if (f.label) fieldByLabel.set(norm(f.label), f);
    // Fall back to name so labels that differ only by name still resolve.
    if (f.name && !fieldByLabel.has(norm(f.name))) fieldByLabel.set(norm(f.name), f);
  }

  const overviewField = args.overview === 'custom'
    ? fieldByLabel.get(norm(OVERVIEW_CUSTOM_FIELD_LABEL)) || null
    : null;
  if (args.overview === 'custom' && !overviewField) {
    console.error(`ERROR: --overview=custom but no org-scoped preference field labelled "${OVERVIEW_CUSTOM_FIELD_LABEL}" was found. Aborting.`);
    process.exit(1);
  }

  // Classify every non-key column.
  const mapping = []; // { column, kind: 'core'|'pref'|'overview'|'unresolved', target }
  for (const col of header) {
    if (col === KEY_COLUMN) continue;
    if (CORE_COLUMN_MAP[col]) {
      mapping.push({ column: col, kind: 'core', target: CORE_COLUMN_MAP[col] });
    } else if (col === OVERVIEW_COLUMN) {
      if (args.overview === 'custom') {
        mapping.push({ column: col, kind: 'pref', target: overviewField, note: '(overview -> custom field)' });
      } else {
        mapping.push({ column: col, kind: 'core', target: 'description', note: '(overview -> core description)' });
      }
    } else {
      const field = fieldByLabel.get(norm(col));
      if (field) mapping.push({ column: col, kind: 'pref', target: field });
      else mapping.push({ column: col, kind: 'unresolved', target: null });
    }
  }

  // 4. Print the resolved mapping.
  console.log('--- Column mapping ---');
  console.log(`  ${pad('spreadsheet column', 28)} ${pad('target', 34)} type`);
  console.log(`  ${'-'.repeat(28)} ${'-'.repeat(34)} ${'-'.repeat(12)}`);
  for (const m of mapping) {
    if (m.kind === 'core') {
      console.log(`  ${pad(m.column, 28)} ${pad(`core.${m.target}`, 34)} (core)${m.note ? ' ' + m.note : ''}`);
    } else if (m.kind === 'pref') {
      console.log(`  ${pad(m.column, 28)} ${pad(`pref: ${m.target.label} [${m.target.name}]`, 34)} ${m.target.field_type}${m.note ? ' ' + m.note : ''}`);
    } else {
      console.log(`  ${pad(m.column, 28)} ${pad('*** UNRESOLVED — skipped ***', 34)}`);
    }
  }
  const unresolved = mapping.filter((m) => m.kind === 'unresolved');
  if (unresolved.length > 0) {
    console.log(`\n  ${unresolved.length} unresolved column(s) will be SKIPPED: ${unresolved.map((u) => u.column).join(', ')}`);
    // Count non-blank cells so reviewers know how much data is being skipped.
    for (const u of unresolved) {
      const nonBlank = rows.filter((r) => !isBlank(r[u.column])).length;
      console.log(`    - "${u.column}": ${nonBlank} non-blank cell(s) not written`);
    }
  }

  // 5. Pre-load existing preference values for the fields we will touch.
  const prefFields = mapping.filter((m) => m.kind === 'pref').map((m) => m.target);
  const prefFieldIds = [...new Set(prefFields.map((f) => f.id))];
  const existingPref = new Map(); // `${orgId}::${fieldId}` -> { id, value }
  if (prefFieldIds.length > 0) {
    const orgIds = [...orgsById.keys()];
    // PostgREST caps a single response at 1000 rows. A naive
    // `.in(org).in(field)` for a 200-org slice can match thousands of rows, so
    // page through each slice with `.range()` until it is exhausted — otherwise
    // existing rows silently look "empty" and the writer would try to INSERT
    // over an already-present row (unique (organization_id, field_id)).
    const PAGE = 1000;
    for (let i = 0; i < orgIds.length; i += CHUNK) {
      const slice = orgIds.slice(i, i + CHUNK);
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('organization_preference_value')
          .select('id, organization_id, field_id, value')
          .in('organization_id', slice)
          .in('field_id', prefFieldIds)
          // A stable ORDER BY is REQUIRED with ranged pagination: without it
          // PostgREST returns rows in arbitrary order per page, so pages overlap
          // and skip rows — existing values then read as "empty" and get
          // needlessly (though harmlessly) re-written, never converging.
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`organization_preference_value load failed: ${error.message}`);
        for (const r of data || []) {
          existingPref.set(`${r.organization_id}::${r.field_id}`, { id: r.id, value: r.value });
        }
        if (!data || data.length < PAGE) break;
      }
    }
  }

  // 6. Compute the per-org plan.
  const plans = []; // { org, coreChanges: [{column,target,old,new}], prefChanges: [{column,field,old,new,stored,existing}] }
  let orgsWithChanges = 0;
  let coreFieldChangeTotal = 0;
  let prefFieldChangeTotal = 0;
  let blankSkips = 0;

  for (const row of rows) {
    const id = String(row[KEY_COLUMN]).trim();
    const org = orgsById.get(id);
    const coreChanges = [];
    const prefChanges = [];

    for (const m of mapping) {
      if (m.kind === 'unresolved') continue;
      const raw = row[m.column];
      if (isBlank(raw)) { blankSkips++; continue; }

      if (m.kind === 'core') {
        const { display, stored } = encodeCore(raw);
        const oldVal = org[m.target] == null ? '' : String(org[m.target]);
        // `status` is a lowercase enum-like value in this DB (e.g. 'active').
        // Treat a case-only difference as no change so the import does not
        // pointlessly flip every org's status casing (which would break
        // lowercase status comparisons elsewhere). A genuine status change
        // (active -> inactive) still surfaces.
        const sameAsOld = m.target === 'status'
          ? oldVal.toLowerCase() === stored.toLowerCase()
          : oldVal === stored;
        if (sameAsOld) continue;
        coreChanges.push({ column: m.column, target: m.target, old: oldVal, new: stored, display });
      } else {
        const field = m.target;
        const { display, stored } = encodeForField(raw, field.field_type);
        const existing = existingPref.get(`${id}::${field.id}`) || null;
        const oldVal = existing ? (existing.value == null ? '' : String(existing.value)) : '';
        if (oldVal === stored) continue;
        prefChanges.push({ column: m.column, field, old: oldVal, new: stored, display, existing });
      }
    }

    if (coreChanges.length > 0 || prefChanges.length > 0) {
      orgsWithChanges++;
      coreFieldChangeTotal += coreChanges.length;
      prefFieldChangeTotal += prefChanges.length;
      plans.push({ org, coreChanges, prefChanges });
    }
  }

  // 7. Print per-org diffs.
  console.log('\n--- Proposed changes (per organisation) ---');
  if (plans.length === 0) {
    console.log('  No changes — every mapped, non-blank cell already matches the DB.');
  }
  for (const p of plans) {
    console.log(`\n  ${p.org.id}  ${truncate(p.org.name || '(unnamed)', 60)}`);
    for (const c of p.coreChanges) {
      console.log(`    [core] ${pad(c.target, 16)} ${truncate(c.old || '(empty)', 40)}  ->  ${truncate(c.display, 60)}`);
    }
    for (const c of p.prefChanges) {
      const label = `${c.field.label} [${c.field.field_type}]`;
      console.log(`    [pref] ${pad(truncate(label, 30), 30)} ${truncate(c.old || '(empty)', 36)}  ->  ${truncate(c.display, 60)}`);
    }
  }

  // 8. Summary.
  const printSummary = (heading) => {
    console.log(`\n=== ${heading} ===`);
    console.log(`  Orgs in sheet:          ${ids.length}`);
    console.log(`  Orgs matched in DB:     ${orgsById.size}`);
    console.log(`  Orgs not found:         ${missingIds.length}`);
    console.log(`  Orgs with changes:      ${orgsWithChanges}`);
    console.log(`  Core field changes:     ${coreFieldChangeTotal}`);
    console.log(`  Pref field changes:     ${prefFieldChangeTotal}`);
    console.log(`  Blank cells skipped:    ${blankSkips}`);
    console.log(`  Unresolved columns:     ${unresolved.length}${unresolved.length ? ' (' + unresolved.map((u) => u.column).join(', ') + ')' : ''}`);
  };

  if (!args.apply) {
    printSummary('DRY RUN summary');
    console.log('\n  No rows were modified. Re-run with --apply to perform the updates.\n');
    return;
  }

  // Guardrail: refuse to write while any column is unresolved, so a silently
  // skipped column can't turn --apply into a partial import. The operator must
  // either create the matching preference field or explicitly acknowledge the
  // skip with --allow-unresolved.
  if (unresolved.length > 0 && !args.allowUnresolved) {
    console.error(`\nERROR: ${unresolved.length} column(s) are unresolved and would be silently skipped: ${unresolved.map((u) => u.column).join(', ')}.`);
    console.error('Refusing to write. Create the matching preference field(s), or re-run with --allow-unresolved to import only the resolved columns.');
    process.exit(1);
  }

  // 9. Apply.
  console.log('\n--- Applying updates ---');
  const applied = { coreOrgs: 0, coreFields: 0, prefWrites: 0, prefBatches: 0, failures: [] };

  // Core columns: a single update per org carrying all changed core fields.
  for (const p of plans) {
    if (p.coreChanges.length === 0) continue;
    const patch = {};
    for (const c of p.coreChanges) patch[c.target] = c.new;
    const { error } = await supabase.from('organization').update(patch).eq('id', p.org.id);
    if (error) {
      applied.failures.push({ id: p.org.id, scope: 'core', error: error.message });
      console.log(`    [error] core ${p.org.id}: ${error.message}`);
    } else {
      applied.coreOrgs++;
      applied.coreFields += p.coreChanges.length;
    }
  }

  // Preference values: one idempotent, batched upsert keyed on the unique
  // (organization_id, field_id) constraint. This both inserts missing rows and
  // overwrites existing ones in a single round-trip per batch, so it is safe to
  // re-run and does not depend on whether the row was seen during pre-load.
  const upsertRows = [];
  for (const p of plans) {
    for (const c of p.prefChanges) {
      upsertRows.push({
        organization_id: p.org.id,
        field_id: c.field.id,
        value: c.new,
        updated_at: new Date().toISOString(),
      });
    }
  }
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
  console.log(`  Core org rows updated:  ${applied.coreOrgs} (${applied.coreFields} field writes)`);
  console.log(`  Pref values written:    ${applied.prefWrites} (${applied.prefBatches} batch upsert(s))`);
  console.log(`  Failures:               ${applied.failures.length}`);
  if (applied.failures.length > 0) {
    console.log('\n  Failures:');
    applied.failures.forEach((f) => console.log(`    ${f.id} (${f.scope}): ${f.error}`));
    process.exitCode = 1;
  }
  console.log('\n  Done. Re-run with --apply to confirm idempotency (should report zero changes).\n');
}

main().catch((err) => {
  console.error('\nFATAL:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
