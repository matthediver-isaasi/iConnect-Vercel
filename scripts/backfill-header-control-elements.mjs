// Backfill positionable header control elements (search / social / account) for
// existing tenants so the new dynamic header renders the same controls the old
// static header used to show.
//
// Each control is created as a navigation_item with link_type='content_block' and
// content_block_type in {'search','social','account'}, placed in the Top Bar.
//
// Idempotent: a control type is only created for a tenant that does not already
// have one of that type across the Top Bar or Main Nav. Safe to re-run.
//
// Usage:
//   node scripts/backfill-header-control-elements.mjs            # dry-run (default)
//   node scripts/backfill-header-control-elements.mjs --apply    # write changes
//   node scripts/backfill-header-control-elements.mjs --apply --tenant=<uuid>
//
// Targets the destination (prod) Supabase via REST (IPv4-reachable from Replit).

import { createClient } from '@supabase/supabase-js';
import {
  normalizeHeaderToggles,
  resolveLoginPosition,
  buildHeaderControlInserts,
  orderedControlTypes,
} from '../api/_lib/headerControlSeed.js';

const APPLY = process.argv.includes('--apply');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const ONLY_TENANT = tenantArg ? tenantArg.split('=')[1] : null;

const supabaseUrl = process.env.DEST_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.DEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

async function getTenants() {
  if (ONLY_TENANT) {
    const { data, error } = await supabase
      .from('tenant')
      .select('id, slug, name, header_config')
      .eq('id', ONLY_TENANT);
    if (error) throw error;
    return data || [];
  }
  const { data, error } = await supabase.from('tenant').select('id, slug, name, header_config');
  if (error) throw error;
  return data || [];
}

// Map of tenant_id -> header_icons_config toggles, loaded once.
async function getToggleMap() {
  const map = {};
  let from = 0;
  const pageSize = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = supabase
      .from('system_settings')
      .select('tenant_id, setting_value')
      .eq('setting_key', 'header_icons_config')
      .range(from, from + pageSize - 1);
    if (ONLY_TENANT) query = query.eq('tenant_id', ONLY_TENANT);
    const { data, error } = await query;
    if (error) throw error;
    for (const row of data || []) {
      map[row.tenant_id] = normalizeHeaderToggles(row.setting_value);
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

async function backfillTenant(tenant) {
  const { data: existing, error } = await supabase
    .from('navigation_item')
    .select('content_block_type')
    .eq('tenant_id', tenant.id)
    .eq('link_type', 'content_block')
    .in('location', ['top_nav', 'main_nav']);

  if (error) {
    console.error(`  [${tenant.slug}] error reading nav items: ${error.message}`);
    return { created: 0, skipped: 0 };
  }

  const existingTypes = new Set((existing || []).map((r) => r.content_block_type));
  const toggles = tenant._toggles;
  const position = resolveLoginPosition(tenant.header_config);
  const toInsert = buildHeaderControlInserts({
    tenantId: tenant.id,
    toggles,
    position,
    existingTypes,
  });

  // Controls intentionally not created because their legacy toggle is off.
  const disabledTypes = orderedControlTypes(position).filter(
    (t) => toggles[t === 'account' ? 'login' : t] === false
  );

  if (toInsert.length === 0) {
    return { created: 0 };
  }

  const types = toInsert.map((i) => `${i.content_block_type}#${i.display_order}`).join(', ');
  const offNote = disabledTypes.length ? ` (off: ${disabledTypes.join(', ')})` : '';
  if (!APPLY) {
    console.log(`  [${tenant.slug}] would create: ${types}${offNote}`);
    return { created: toInsert.length };
  }

  const { error: insertError } = await supabase.from('navigation_item').insert(toInsert);
  if (insertError) {
    console.error(`  [${tenant.slug}] insert failed: ${insertError.message}`);
    return { created: 0 };
  }
  console.log(`  [${tenant.slug}] created: ${types}${offNote}`);
  return { created: toInsert.length };
}

async function main() {
  console.log(`Header control element backfill — mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  if (ONLY_TENANT) console.log(`Scoped to tenant: ${ONLY_TENANT}`);

  const tenants = await getTenants();
  const toggleMap = await getToggleMap();
  console.log(`Found ${tenants.length} tenant(s).\n`);

  let totalCreated = 0;
  for (const tenant of tenants) {
    // Default to all-on when a tenant has no header_icons_config row (matches
    // the old default-on header).
    tenant._toggles = toggleMap[tenant.id] || normalizeHeaderToggles(null);
    const { created } = await backfillTenant(tenant);
    totalCreated += created;
  }

  console.log(
    `\nDone. ${APPLY ? 'Created' : 'Would create'} ${totalCreated} header control element(s) across ${tenants.length} tenant(s).`
  );
  if (!APPLY) console.log('Re-run with --apply to write changes.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
