import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY (or fallback SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const argTenantId = process.argv[2] || null;
const DEFAULT_TENANT = '21296ad6-1350-483a-a90c-1b06ece70501';
const tenantFilter = argTenantId === '--all' ? null : (argTenantId || DEFAULT_TENANT);

async function run() {
  console.log(`Backfilling membership_tier_config.field_name from preference_field.label`);
  console.log(`Tenant filter: ${tenantFilter || '(all tenants)'}\n`);

  let query = supabase
    .from('membership_tier_config')
    .select('id, tenant_id, name, field_source, field_id, field_name, effective_to')
    .eq('field_source', 'custom')
    .not('field_id', 'is', null);

  if (tenantFilter) query = query.eq('tenant_id', tenantFilter);

  const { data: configs, error } = await query;
  if (error) {
    console.error('Failed to fetch configs:', error);
    process.exit(1);
  }

  if (!configs || configs.length === 0) {
    console.log('No custom-field-based configs found.');
    return;
  }

  const fieldIds = [...new Set(configs.map(c => c.field_id))];
  const { data: fields, error: fieldsErr } = await supabase
    .from('preference_field')
    .select('id, label, name, tenant_id')
    .in('id', fieldIds);

  if (fieldsErr) {
    console.error('Failed to fetch preference_field rows:', fieldsErr);
    process.exit(1);
  }

  const fieldMap = new Map((fields || []).map(f => [f.id, f]));

  let updated = 0;
  let unchanged = 0;
  let missing = 0;

  for (const config of configs) {
    const fld = fieldMap.get(config.field_id);
    if (!fld) {
      console.warn(`  [MISSING] config ${config.id} ("${config.name}") references preference_field ${config.field_id} which was not found`);
      missing++;
      continue;
    }
    const desiredLabel = fld.label || fld.name || null;
    if (!desiredLabel) {
      console.warn(`  [SKIP] config ${config.id} ("${config.name}") - preference_field has no label or name`);
      continue;
    }
    if (config.field_name === desiredLabel) {
      unchanged++;
      continue;
    }

    console.log(`  [UPDATE] config ${config.id} ("${config.name}", tenant ${config.tenant_id})`);
    console.log(`           field_name: "${config.field_name}" -> "${desiredLabel}" (effective_to: ${config.effective_to ?? 'active'})`);

    const { error: updateErr } = await supabase
      .from('membership_tier_config')
      .update({ field_name: desiredLabel, updated_at: new Date().toISOString() })
      .eq('id', config.id)
      .eq('tenant_id', config.tenant_id);

    if (updateErr) {
      console.error(`           FAILED:`, updateErr);
    } else {
      updated++;
    }
  }

  console.log(`\nSummary: ${updated} updated, ${unchanged} already correct, ${missing} missing preference_field.`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
