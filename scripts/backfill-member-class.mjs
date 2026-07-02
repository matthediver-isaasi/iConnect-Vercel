import { createClient } from '@supabase/supabase-js';

const TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';
const FIELD_NAME = 'member_class';
const TARGET_VALUE = 'University';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

if (!supabaseKey) {
  console.error('Missing DEST_SUPABASE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const isExecute = process.argv.includes('--execute');
const mode = isExecute ? 'EXECUTE' : 'DRY RUN';

const orgArgIndex = process.argv.indexOf('--org');
const targetOrgId = orgArgIndex !== -1 ? process.argv[orgArgIndex + 1] : null;

async function run() {
  console.log(`\n=== Backfill member_class = "${TARGET_VALUE}" ===`);
  console.log(`Mode: ${mode}`);
  console.log(`Tenant: ${TENANT_ID}`);
  console.log(`Organisation: ${targetOrgId || 'All organisations'}\n`);

  const { data: field, error: fieldError } = await supabase
    .from('preference_field')
    .select('id, name, label')
    .eq('name', FIELD_NAME)
    .eq('entity_scope', 'member')
    .maybeSingle();

  if (fieldError) {
    console.error('Failed to look up preference_field:', fieldError.message);
    process.exit(1);
  }

  if (!field) {
    console.error(`No preference_field found with name="${FIELD_NAME}" for tenant ${TENANT_ID}`);
    process.exit(1);
  }

  console.log(`Found field: "${field.label}" (${field.id})\n`);

  let allMembers = [];
  let from = 0;
  const PAGE_SIZE = 1000;

  while (true) {
    let query = supabase
      .from('member')
      .select('id, first_name, last_name, email, organization_id')
      .eq('tenant_id', TENANT_ID)
      .not('organization_id', 'is', null);
    if (targetOrgId) {
      query = query.eq('organization_id', targetOrgId);
    }
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('Failed to fetch members:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    allMembers = allMembers.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(`Found ${allMembers.length} members with an organisation link\n`);

  if (allMembers.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const memberIds = allMembers.map(m => m.id);
  let existingValues = [];
  const LOOKUP_BATCH = 200;
  for (let i = 0; i < memberIds.length; i += LOOKUP_BATCH) {
    const batch = memberIds.slice(i, i + LOOKUP_BATCH);
    const { data, error } = await supabase
      .from('member_preference_value')
      .select('id, member_id, value')
      .eq('field_id', field.id)
      .in('member_id', batch);

    if (error) {
      console.error('Failed to fetch existing values:', error.message);
      process.exit(1);
    }
    if (data) existingValues = existingValues.concat(data);
  }

  const existingByMember = new Map(existingValues.map(v => [v.member_id, v]));

  let stats = { alreadyCorrect: 0, wouldCreate: 0, wouldUpdate: 0, created: 0, updated: 0, errors: 0 };

  for (const member of allMembers) {
    const existing = existingByMember.get(member.id);
    const label = `${member.first_name} ${member.last_name} (${member.email})`;

    if (existing && existing.value === TARGET_VALUE) {
      stats.alreadyCorrect++;
      continue;
    }

    if (existing) {
      console.log(`  [UPDATE] ${label} — current value: "${existing.value}" -> "${TARGET_VALUE}"`);
      stats.wouldUpdate++;

      if (isExecute) {
        const { error } = await supabase
          .from('member_preference_value')
          .update({ value: TARGET_VALUE })
          .eq('id', existing.id);

        if (error) {
          console.error(`    ERROR updating ${member.id}:`, error.message);
          stats.errors++;
        } else {
          stats.updated++;
        }
      }
    } else {
      console.log(`  [CREATE] ${label} — set "${FIELD_NAME}" = "${TARGET_VALUE}"`);
      stats.wouldCreate++;

      if (isExecute) {
        const { error } = await supabase
          .from('member_preference_value')
          .upsert({
            member_id: member.id,
            field_id: field.id,
            value: TARGET_VALUE,
          }, { onConflict: 'member_id,field_id' });

        if (error) {
          console.error(`    ERROR creating for ${member.id}:`, error.message);
          stats.errors++;
        } else {
          stats.created++;
        }
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total members with org: ${allMembers.length}`);
  console.log(`Already correct:        ${stats.alreadyCorrect}`);
  if (isExecute) {
    console.log(`Created:                ${stats.created}`);
    console.log(`Updated:                ${stats.updated}`);
    console.log(`Errors:                 ${stats.errors}`);
  } else {
    console.log(`Would create:           ${stats.wouldCreate}`);
    console.log(`Would update:           ${stats.wouldUpdate}`);
    console.log('\nRun with --execute to apply changes.');
  }
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
