// One-off import: GSF member_type_sub_category values from spreadsheet.
// Task: import 218 organisation custom-field values for tenant Global Schools Forum.
// Source: attached_assets/Import_primary_type_new_dropdown_1784529318861.xlsx
//   col 1 = organization UUID, col 2 = new dropdown value.
// Hard-pinned to the GSF tenant and the member_type_sub_category preference field.
// Dry-run by default; pass --apply to write.
// Usage: node scripts/import-gsf-member-type-subcategory.mjs [--apply]

import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501'; // gsf
const FIELD_ID = '0cf72e9f-000f-473a-a3f0-c8716bb14226'; // member_type_sub_category
const XLSX_PATH = 'attached_assets/Import_primary_type_new_dropdown_1784529318861.xlsx';

// Org appears twice with conflicting values; user will set it manually.
const SKIP_ORG_IDS = new Set(['5544953b-d992-4091-b9ed-68c3c4abdf52']);

const CANONICAL_OPTIONS = [
  'Education Support Orgs',
  'Education Support Orgs with Schools',
  'Standalone School',
  'School Network',
];
// Case-insensitive normalization to canonical option values.
const NORMALIZE = new Map(CANONICAL_OPTIONS.map((v) => [v.toLowerCase(), v]));

const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.DEST_SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

async function main() {
  console.log(APPLY ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to write) ===');

  // 1. Verify field definition
  const { data: field, error: fieldErr } = await supabase
    .from('preference_field')
    .select('id, name, field_type, entity_scope, tenant_id')
    .eq('id', FIELD_ID)
    .single();
  if (fieldErr) throw new Error(`Field lookup failed: ${fieldErr.message}`);
  if (field.tenant_id !== TENANT_ID || field.name !== 'member_type_sub_category') {
    throw new Error(`Field sanity check failed: ${JSON.stringify(field)}`);
  }

  // 2. Read spreadsheet
  const wb = XLSX.readFile(XLSX_PATH);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const dataRows = rows.slice(1).filter((r) => r[0]); // skip header

  const skipped = [];
  const invalid = [];
  const byOrg = new Map(); // orgId -> canonical value

  for (const [rawId, rawValue] of dataRows) {
    const orgId = String(rawId).trim().toLowerCase();
    if (SKIP_ORG_IDS.has(orgId)) {
      if (!skipped.includes(orgId)) skipped.push(orgId);
      continue;
    }
    const value = NORMALIZE.get(String(rawValue ?? '').trim().toLowerCase());
    if (!value) {
      invalid.push({ orgId, rawValue });
      continue;
    }
    const existing = byOrg.get(orgId);
    if (existing && existing !== value) {
      throw new Error(`Unexpected conflicting values for org ${orgId}: "${existing}" vs "${value}"`);
    }
    byOrg.set(orgId, value);
  }

  if (invalid.length) {
    console.error('Invalid values (not matching field options):', invalid);
    throw new Error(`${invalid.length} rows have values not in the field's option list`);
  }
  console.log(`Spreadsheet: ${dataRows.length} data rows -> ${byOrg.size} unique orgs, ${skipped.length} skipped (conflicting)`);

  const orgIds = [...byOrg.keys()];

  // 3. Verify all orgs exist under the GSF tenant (paginate to dodge 1000-row cap)
  const foundOrgs = new Set();
  for (let i = 0; i < orgIds.length; i += 200) {
    const chunk = orgIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization')
      .select('id')
      .eq('tenant_id', TENANT_ID)
      .in('id', chunk);
    if (error) throw new Error(`Org lookup failed: ${error.message}`);
    data.forEach((o) => foundOrgs.add(o.id));
  }
  const missing = orgIds.filter((id) => !foundOrgs.has(id));
  if (missing.length) {
    console.error('Orgs not found under GSF tenant:', missing);
    throw new Error(`${missing.length} org UUIDs missing from tenant`);
  }

  // 4. Fetch existing preference values for this field
  const existingByOrg = new Map();
  for (let i = 0; i < orgIds.length; i += 200) {
    const chunk = orgIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization_preference_value')
      .select('id, organization_id, value')
      .eq('field_id', FIELD_ID)
      .in('organization_id', chunk);
    if (error) throw new Error(`Existing values lookup failed: ${error.message}`);
    data.forEach((r) => existingByOrg.set(r.organization_id, r));
  }

  // 5. Plan
  const toInsert = [];
  const toUpdate = [];
  let unchanged = 0;
  for (const [orgId, value] of byOrg) {
    const existing = existingByOrg.get(orgId);
    if (!existing) {
      toInsert.push({ organization_id: orgId, field_id: FIELD_ID, value });
    } else if (existing.value === value) {
      unchanged += 1;
    } else {
      toUpdate.push({ id: existing.id, orgId, from: existing.value, to: value });
    }
  }

  console.log(`Plan: ${toInsert.length} inserts, ${toUpdate.length} updates, ${unchanged} unchanged, ${skipped.length} skipped`);
  if (toUpdate.length) {
    console.log('Sample updates:', toUpdate.slice(0, 5).map((u) => `${u.orgId}: "${u.from}" -> "${u.to}"`));
  }

  if (!APPLY) {
    console.log('Dry run complete. No changes made.');
    return;
  }

  // 6. Apply
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 100) {
    const chunk = toInsert.slice(i, i + 100);
    const { error } = await supabase.from('organization_preference_value').insert(chunk);
    if (error) throw new Error(`Insert failed at chunk ${i}: ${error.message}`);
    inserted += chunk.length;
  }

  let updated = 0;
  for (const u of toUpdate) {
    const { error } = await supabase
      .from('organization_preference_value')
      .update({ value: u.to })
      .eq('id', u.id);
    if (error) throw new Error(`Update failed for org ${u.orgId}: ${error.message}`);
    updated += 1;
  }

  console.log('=== DONE ===');
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Skipped (conflicting, set manually): ${skipped.join(', ')}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
