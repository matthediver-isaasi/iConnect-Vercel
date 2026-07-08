// Import GSF "Go live date" (go_live) organisational custom field values from
// attached_assets/Organisations_date_member_since_08.07.26_1783505156783.xlsx.
//
// Hard-pinned to the Global Schools Forum tenant and the go_live field.
// Reads Sheet1 columns: id (organization UUID), Registration_Date (Excel serial date).
// Converts Excel serials to YYYY-MM-DD (Excel 1900 date system via the xlsx library)
// and upserts into organization_preference_value keyed on (organization_id, field_id).
//
// Usage:
//   node scripts/import-gsf-go-live-dates.mjs           # dry-run (default): prints planned changes
//   node scripts/import-gsf-go-live-dates.mjs --apply   # perform the writes
//
// Idempotent: re-running with --apply is a no-op once values match.

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501'; // gsf
const FIELD_ID = '7e4cb8fd-7d7a-4fa9-814a-67ebb054cd0e'; // go_live (date)
const XLSX_PATH = 'attached_assets/Organisations_date_member_since_08.07.26_1783505156783.xlsx';

const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

function excelSerialToISO(serial) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  const d = XLSX.SSF.parse_date_code(serial);
  if (!d || !d.y || !d.m || !d.d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
}

async function fetchAll(table, select, filterFn) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    q = filterFn(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // 1. Read spreadsheet
  const wb = XLSX.readFile(XLSX_PATH);
  const ws = wb.Sheets['Sheet1'];
  if (!ws) throw new Error('Sheet1 not found in workbook');
  const rows = XLSX.utils.sheet_to_json(ws);
  console.log(`Rows read from spreadsheet: ${rows.length}`);

  // Parse + validate rows
  const parsed = [];
  const badRows = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row.id || '').trim();
    const iso = excelSerialToISO(row.Registration_Date);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !iso) {
      badRows.push(row);
      continue;
    }
    if (seen.has(id)) {
      badRows.push({ ...row, reason: 'duplicate id' });
      continue;
    }
    seen.add(id);
    parsed.push({ id, date: iso });
  }
  if (badRows.length) {
    console.error(`Invalid/duplicate rows (${badRows.length}):`, badRows);
    throw new Error('Aborting: spreadsheet contains invalid rows');
  }

  // 2. Validate all org ids belong to the gsf tenant
  const ids = parsed.map((r) => r.id);
  const orgs = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization')
      .select('id, tenant_id, name')
      .in('id', chunk);
    if (error) throw new Error(`organization fetch failed: ${error.message}`);
    orgs.push(...(data || []));
  }
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const missing = ids.filter((id) => !orgById.has(id));
  const foreign = ids.filter((id) => orgById.has(id) && orgById.get(id).tenant_id !== TENANT_ID);
  if (missing.length || foreign.length) {
    console.error('Missing org ids:', missing);
    console.error('Foreign-tenant org ids:', foreign);
    throw new Error('Aborting: some org ids are missing or belong to another tenant');
  }
  console.log(`Validated: all ${ids.length} organisations exist and belong to the gsf tenant.`);

  // 3. Fetch existing go_live values for these orgs
  const existing = await fetchAll('organization_preference_value', 'id, organization_id, value', (q) =>
    q.eq('field_id', FIELD_ID).in('organization_id', ids)
  );
  const existingByOrg = new Map(existing.map((r) => [r.organization_id, r]));

  // 4. Plan changes
  const toInsert = [];
  const toUpdate = [];
  let skipped = 0;
  for (const { id, date } of parsed) {
    const cur = existingByOrg.get(id);
    if (!cur) {
      toInsert.push({ organization_id: id, field_id: FIELD_ID, value: date });
    } else if (cur.value !== date) {
      toUpdate.push({ rowId: cur.id, organization_id: id, from: cur.value, to: date });
    } else {
      skipped++;
    }
  }

  console.log(`Planned: insert=${toInsert.length}, update=${toUpdate.length}, skip(already correct)=${skipped}`);
  const sample = toInsert.slice(0, 10).map((r) => `${r.organization_id} (${orgById.get(r.organization_id)?.name}) -> ${r.value}`);
  if (sample.length) console.log('Sample inserts:\n  ' + sample.join('\n  '));
  if (toUpdate.length) console.log('Updates:', toUpdate);

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to write.');
    return;
  }

  // 5. Apply
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100);
    const { error } = await supabase.from('organization_preference_value').insert(chunk);
    if (error) throw new Error(`insert failed at chunk ${i}: ${error.message}`);
    inserted += chunk.length;
  }
  let updated = 0;
  for (const u of toUpdate) {
    const { error } = await supabase
      .from('organization_preference_value')
      .update({ value: u.to })
      .eq('id', u.rowId);
    if (error) throw new Error(`update failed for ${u.organization_id}: ${error.message}`);
    updated++;
  }

  console.log(`\nSummary: read=${rows.length}, inserted=${inserted}, updated=${updated}, skipped=${skipped}`);

  // 6. Verify
  const after = await fetchAll('organization_preference_value', 'organization_id, value', (q) =>
    q.eq('field_id', FIELD_ID).in('organization_id', ids)
  );
  const afterByOrg = new Map(after.map((r) => [r.organization_id, r.value]));
  const mismatches = parsed.filter((r) => afterByOrg.get(r.id) !== r.date);
  if (mismatches.length) {
    console.error('VERIFY FAILED — mismatched rows:', mismatches);
    process.exit(1);
  }
  console.log(`Verify: all ${parsed.length} organisations have the correct go_live value.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
