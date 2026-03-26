import { createClient } from '@supabase/supabase-js';

const dbUrl = process.env.DEST_DATABASE_URL || '';
const match = dbUrl.match(/postgres\.([^:]+):/);
const projectRef = match ? match[1] : null;
if (!projectRef) {
  console.error('Could not extract project ref from DEST_DATABASE_URL');
  process.exit(1);
}
const supabaseUrl = `https://${projectRef}.supabase.co`;
const supabaseKey = process.env.DEST_SUPABASE_KEY;
if (!supabaseKey) {
  console.error('DEST_SUPABASE_KEY is required');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const BATCH_SIZE = 500;

async function fetchAllMemberIds(tenantId) {
  const allIds = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('member')
      .select('id')
      .eq('tenant_id', tenantId)
      .not('email', 'like', 'deleted_%@deleted.local')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allIds.push(...data.map(m => m.id));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return allIds;
}

async function fetchExistingPrefMemberIds(categoryId) {
  const existing = new Set();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('member_communication_preference')
      .select('member_id')
      .eq('category_id', categoryId)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) existing.add(row.member_id);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return existing;
}

async function run() {
  console.log('=== Backfill Communication Preferences ===');
  console.log('Setting is_subscribed=true for all active members missing preference records.\n');

  const { data: tenants, error: tErr } = await supabase
    .from('communication_category')
    .select('tenant_id');
  if (tErr) throw tErr;

  const tenantIds = [...new Set((tenants || []).map(c => c.tenant_id))];
  console.log(`Found ${tenantIds.length} tenant(s) with communication categories.\n`);

  let totalInserted = 0;

  for (const tenantId of tenantIds) {
    console.log(`--- Tenant: ${tenantId} ---`);

    const { data: categories, error: catErr } = await supabase
      .from('communication_category')
      .select('id, name')
      .eq('tenant_id', tenantId);
    if (catErr) throw catErr;

    const memberIds = await fetchAllMemberIds(tenantId);
    console.log(`  Active members: ${memberIds.length}`);
    console.log(`  Categories: ${categories.length}`);

    for (const cat of categories) {
      const existingSet = await fetchExistingPrefMemberIds(cat.id);
      const missingIds = memberIds.filter(mid => !existingSet.has(mid));
      console.log(`  Category "${cat.name}" (${cat.id}): ${existingSet.size} existing, ${missingIds.length} missing`);

      if (missingIds.length === 0) {
        console.log(`    -> Nothing to backfill.`);
        continue;
      }

      for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
        const batch = missingIds.slice(i, i + BATCH_SIZE);
        const records = batch.map(memberId => ({
          member_id: memberId,
          category_id: cat.id,
          tenant_id: tenantId,
          is_subscribed: true,
        }));

        const { error: insErr } = await supabase
          .from('member_communication_preference')
          .upsert(records, { onConflict: 'member_id,category_id', ignoreDuplicates: true });

        if (insErr) {
          console.error(`    -> Error inserting batch ${Math.floor(i / BATCH_SIZE) + 1}:`, insErr.message);
        } else {
          totalInserted += batch.length;
          console.log(`    -> Inserted batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} records`);
        }
      }
    }
    console.log('');
  }

  console.log(`=== Done. Total records inserted: ${totalInserted} ===`);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
