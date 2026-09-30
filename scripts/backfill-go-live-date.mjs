import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL || 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;
const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const DRY_RUN = process.argv.includes('--dry-run');

if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY environment variable is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log(`\n=== Backfill go_live date from created_at ===`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  const { data: goLiveField, error: goLiveErr } = await supabase
    .from('preference_field')
    .select('id, name, label, field_type')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .or('name.eq.go_live,name.ilike.%go_live%,label.ilike.%go live%,label.ilike.%go_live%')
    .limit(5);

  if (goLiveErr) {
    console.error('Error finding go_live field:', goLiveErr.message);
    console.log('Listing all org fields to help identify the right one...');
    const { data: allFields } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type')
      .eq('tenant_id', TENANT_ID)
      .eq('entity_scope', 'organization')
      .eq('is_active', true)
      .order('name');
    console.log('Available fields:');
    (allFields || []).forEach(f => console.log(`  - name: ${f.name}, label: ${f.label}, type: ${f.field_type}, id: ${f.id}`));
    process.exit(1);
  }

  if (!goLiveField || goLiveField.length === 0) {
    console.error('Could not find go_live custom field for this tenant.');
    console.log('Listing all org fields to help identify the right one...');
    const { data: allFields } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type')
      .eq('tenant_id', TENANT_ID)
      .eq('entity_scope', 'organization')
      .eq('is_active', true)
      .order('name');
    console.log('Available fields:');
    (allFields || []).forEach(f => console.log(`  - name: ${f.name}, label: ${f.label}, type: ${f.field_type}, id: ${f.id}`));
    process.exit(1);
  }

  const goLiveFieldRecord = goLiveField[0];
  console.log(`Found go_live field: "${goLiveFieldRecord.label || goLiveFieldRecord.name}" (name: ${goLiveFieldRecord.name}, id: ${goLiveFieldRecord.id})`);

  const { data: statusField, error: statusErr } = await supabase
    .from('preference_field')
    .select('id, name, label')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_scope', 'organization')
    .eq('name', 'application_status')
    .eq('is_active', true)
    .single();

  if (statusErr || !statusField) {
    console.error('Could not find application_status field:', statusErr?.message);
    process.exit(1);
  }

  console.log(`Found application_status field: "${statusField.label || statusField.name}" (id: ${statusField.id})`);

  const { data: orgs, error: orgsErr } = await supabase
    .from('organization')
    .select('id, name, created_at')
    .eq('tenant_id', TENANT_ID)
    .order('name');

  if (orgsErr) {
    console.error('Error fetching organisations:', orgsErr.message);
    process.exit(1);
  }

  console.log(`Found ${orgs.length} organisations in tenant\n`);

  const orgIds = orgs.map(o => o.id);

  const { data: statusValues, error: svErr } = await supabase
    .from('organization_preference_value')
    .select('organization_id, value')
    .eq('field_id', statusField.id)
    .in('organization_id', orgIds);

  if (svErr) {
    console.error('Error fetching status values:', svErr.message);
    process.exit(1);
  }

  const statusMap = {};
  (statusValues || []).forEach(sv => {
    let val = sv.value;
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch (e) {}
    }
    if (typeof val === 'object' && val !== null && val.value) val = val.value;
    statusMap[sv.organization_id] = String(val);
  });

  const liveOrgs = orgs.filter(o => {
    const status = statusMap[o.id];
    return status && status.toLowerCase() === 'live';
  });

  console.log(`Organisations with Application Status = "Live": ${liveOrgs.length}`);

  if (liveOrgs.length === 0) {
    console.log('No organisations to backfill.');
    process.exit(0);
  }

  const { data: existingGoLive, error: egErr } = await supabase
    .from('organization_preference_value')
    .select('organization_id, value')
    .eq('field_id', goLiveFieldRecord.id)
    .in('organization_id', liveOrgs.map(o => o.id));

  if (egErr) {
    console.error('Error checking existing go_live values:', egErr.message);
    process.exit(1);
  }

  const existingMap = {};
  (existingGoLive || []).forEach(e => { existingMap[e.organization_id] = e.value; });

  const toUpsert = [];
  const skipped = [];

  for (const org of liveOrgs) {
    if (existingMap[org.id] && existingMap[org.id] !== '' && existingMap[org.id] !== 'null') {
      skipped.push({ name: org.name, existing: existingMap[org.id] });
      continue;
    }

    const createdDate = org.created_at ? org.created_at.split('T')[0] : null;
    if (!createdDate) {
      console.log(`  SKIP: "${org.name}" - no created_at date`);
      continue;
    }

    toUpsert.push({
      organization_id: org.id,
      field_id: goLiveFieldRecord.id,
      value: createdDate
    });
  }

  console.log(`\nWill backfill: ${toUpsert.length} organisations`);
  console.log(`Already have go_live: ${skipped.length} (will not overwrite)`);

  if (skipped.length > 0) {
    console.log('\nSkipped (already have go_live value):');
    skipped.forEach(s => console.log(`  - ${s.name}: ${s.existing}`));
  }

  console.log('\nTo backfill:');
  toUpsert.forEach(u => {
    const org = liveOrgs.find(o => o.id === u.organization_id);
    console.log(`  - ${org?.name}: created_at ${org?.created_at} → go_live = ${u.value}`);
  });

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes made. Run without --dry-run to apply.');
    return;
  }

  if (toUpsert.length === 0) {
    console.log('\nNothing to upsert.');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const record of toUpsert) {
    const { error } = await supabase
      .from('organization_preference_value')
      .upsert(record, { onConflict: 'organization_id,field_id', ignoreDuplicates: false });

    const org = liveOrgs.find(o => o.id === record.organization_id);
    if (error) {
      console.error(`  FAIL: "${org?.name}" - ${error.message}`);
      failed++;
    } else {
      console.log(`  OK: "${org?.name}" → ${record.value}`);
      success++;
    }
  }

  console.log(`\n=== Complete ===`);
  console.log(`Success: ${success}, Failed: ${failed}, Skipped: ${skipped.length}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
