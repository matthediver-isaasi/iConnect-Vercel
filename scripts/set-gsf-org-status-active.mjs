// One-off: set org_status='Active' on every unique organisation referenced
// by the GSF members CSV. Idempotent.
//
// Usage:
//   node scripts/set-gsf-org-status-active.mjs --dry-run
//   node scripts/set-gsf-org-status-active.mjs
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const FIELD_NAME = 'org_status';
const TARGET_VALUE = 'Active';
const DEFAULT_FILE = 'attached_assets/gsfMemberCleaned_1779873272134.csv';
const ORG_COLUMN = 'member.organizarion_id';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileArg = args.find(a => a.startsWith('--file='));
const CSV_PATH = fileArg ? fileArg.split('=')[1] : DEFAULT_FILE;

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

async function fetchAllInChunks(table, select, column, values) {
  const out = [];
  const chunk = 200;
  for (let i = 0; i < values.length; i += chunk) {
    const batch = values.slice(i, i + chunk);
    const { data, error } = await supabase.from(table).select(select).in(column, batch);
    if (error) throw new Error(`Failed fetch from ${table}: ${error.message}`);
    out.push(...(data || []));
  }
  return out;
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== LIVE RUN ===');
  console.log('Tenant:', TENANT_ID);
  console.log('CSV   :', CSV_PATH);
  console.log('');

  // Step 1: resolve org_status field
  const { data: fields, error: fErr } = await supabase
    .from('preference_field')
    .select('id, name, label, entity_scope')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_scope', 'organization');
  if (fErr) { console.error('preference_field lookup failed:', fErr); process.exit(1); }
  const field = fields?.find(f => f.name === FIELD_NAME);
  if (!field) {
    console.error(`Missing preference_field name='${FIELD_NAME}' for tenant ${TENANT_ID}.`);
    console.error('Available organization-scoped preference fields:');
    for (const f of fields || []) console.error(`  ${f.id}  ${f.name}  (label: ${f.label})`);
    process.exit(1);
  }
  console.log(`Resolved field '${FIELD_NAME}' -> ${field.id} (label: ${field.label})`);

  // Step 2: parse CSV, collect unique org IDs
  const raw = readFileSync(CSV_PATH);
  const records = parse(raw, { columns: true, bom: true, skip_empty_lines: true, trim: false });
  const uniqueOrgIds = new Set();
  for (const r of records) {
    const v = r[ORG_COLUMN];
    if (v && String(v).trim() !== '') uniqueOrgIds.add(String(v).trim());
  }
  const orgIds = Array.from(uniqueOrgIds);
  console.log(`CSV rows: ${records.length}`);
  console.log(`Unique organization IDs in CSV: ${orgIds.length}`);

  // Step 3: validate orgs exist in tenant
  const existingOrgs = await fetchAllInChunks(
    'organization',
    'id',
    'id',
    orgIds,
  );
  const existingTenantOrgs = new Set();
  // double-check tenant match
  for (let i = 0; i < orgIds.length; i += 200) {
    const batch = orgIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization')
      .select('id')
      .eq('tenant_id', TENANT_ID)
      .in('id', batch);
    if (error) throw new Error(`organization tenant-scoped fetch failed: ${error.message}`);
    for (const r of data || []) existingTenantOrgs.add(r.id);
  }
  const skipped = orgIds.filter(id => !existingTenantOrgs.has(id));
  const validOrgIds = orgIds.filter(id => existingTenantOrgs.has(id));
  console.log(`Found in tenant: ${validOrgIds.length}`);
  console.log(`Skipped (not in tenant): ${skipped.length}`);

  // Step 4: existing org_status rows for these orgs
  const existingByOrg = new Map(); // organization_id -> { value }
  for (let i = 0; i < validOrgIds.length; i += 200) {
    const batch = validOrgIds.slice(i, i + 200);
    const { data, error } = await supabase
      .from('organization_preference_value')
      .select('organization_id, field_id, value')
      .eq('field_id', field.id)
      .in('organization_id', batch);
    if (error) throw new Error(`existing pref fetch failed: ${error.message}`);
    for (const r of data || []) existingByOrg.set(r.organization_id, r);
  }

  const alreadyCorrect = [];
  const toUpdate = []; // existing row, value !== 'Active'
  const toInsert = []; // no existing row
  for (const orgId of validOrgIds) {
    const cur = existingByOrg.get(orgId);
    if (!cur) toInsert.push(orgId);
    else if ((cur.value ?? '') === TARGET_VALUE) alreadyCorrect.push(orgId);
    else toUpdate.push({ organization_id: orgId, oldValue: cur.value });
  }

  console.log('');
  console.log('=== Plan ===');
  console.log(`Already correct ('${TARGET_VALUE}'): ${alreadyCorrect.length}`);
  console.log(`To update (existing row, different value): ${toUpdate.length}`);
  console.log(`To insert (no existing row): ${toInsert.length}`);
  if (skipped.length) {
    console.log('');
    console.log('Skipped organization IDs (not present in tenant):');
    for (const id of skipped) console.log('  ', id);
  }
  if (toUpdate.length && DRY_RUN) {
    console.log('');
    console.log('Sample updates (first 10):');
    for (const u of toUpdate.slice(0, 10)) console.log(`  ${u.organization_id}: '${u.oldValue}' -> '${TARGET_VALUE}'`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN complete. No changes made.');
    return;
  }

  // Step 5: live writes
  let inserted = 0, updated = 0, errors = 0;

  // Inserts in batches
  for (let i = 0; i < toInsert.length; i += 200) {
    const batch = toInsert.slice(i, i + 200).map(orgId => ({
      organization_id: orgId,
      field_id: field.id,
      value: TARGET_VALUE,
    }));
    const { error } = await supabase.from('organization_preference_value').insert(batch);
    if (error) {
      console.error('Insert batch failed:', error.message);
      errors += batch.length;
    } else {
      inserted += batch.length;
    }
  }

  // Updates one by one (no compound primary key for upsert convenience)
  for (const u of toUpdate) {
    const { error } = await supabase
      .from('organization_preference_value')
      .update({ value: TARGET_VALUE })
      .eq('organization_id', u.organization_id)
      .eq('field_id', field.id);
    if (error) {
      console.error(`Update failed for ${u.organization_id}:`, error.message);
      errors++;
    } else {
      updated++;
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Total unique org IDs in CSV : ${orgIds.length}`);
  console.log(`Skipped (not in tenant)     : ${skipped.length}`);
  console.log(`Already correct             : ${alreadyCorrect.length}`);
  console.log(`Updated                     : ${updated}`);
  console.log(`Inserted                    : ${inserted}`);
  console.log(`Errors                      : ${errors}`);
  if (errors > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
