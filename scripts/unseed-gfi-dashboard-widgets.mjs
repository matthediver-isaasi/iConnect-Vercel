#!/usr/bin/env node
/**
 * Unseed dashboard widgets and seed-created preference fields for the GFI
 * production tenant (task #616). Reverses seed-default-dashboard-widgets.mjs
 * for tenant GFI (`fd82da65-aab7-4a5c-85b8-b2febeb2003d`).
 *
 * Deletes only rows that the seed actually created:
 *   - All 12 shared dashboard_widget rows whose title matches the seed's
 *     known title list (won't touch any custom shared widget an admin
 *     added since seeding).
 *   - The 5 preference_field rows the seed created in GFI (region,
 *     org_legal_type, total_schools, children_impacted_direct,
 *     children_impacted_indirect). The pre-existing `organization.org_type`
 *     field (created 2025-12-09, ~5 months before the seed ran) is
 *     preserved — the seed merely merged options into it, it did not
 *     create the row.
 *   - The seed's `member.go_live` field was never created (the unique
 *     constraint on (tenant_id, name) clashed with GFI's pre-existing
 *     `organization.go_live`), so nothing to delete there.
 *   - Personal widgets and any non-seed shared widgets are left in place.
 *   - Pre-existing GFI `organization.go_live` field is left in place.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/unseed-gfi-dashboard-widgets.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY || process.env.DEST_SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[unseed] DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// GFI tenant id (resolved from the `tenant` table; the slug `gfi` maps to
// "Graduate Futures Institute"). Note: the task description originally
// listed a different uuid which actually points at the `gsf` tenant — the
// uuid below is the one the seed script used as its default and the one
// where the 12 seeded widgets actually live.
const GFI_TENANT_ID = 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

const SEED_WIDGET_TITLES = [
  'Total ESOs',
  'Total SOs',
  'Total Schools',
  'Children Impacted (direct + indirect)',
  'Unique LMIC countries',
  'New ESOs by month (current year)',
  'New ESOs by quarter (current year)',
  'New SOs by month (current year)',
  'New SOs by quarter (current year)',
  'New approved members by month (current year)',
  'New schools by month (current year)',
  'Organisations by region',
  'Organisations by legal type (Non-profit vs For-profit)',
];

// Seed-created preference fields only. `organization.org_type` is excluded
// because GFI created it months before the seed ran — the seed only merged
// options into it. `member.go_live` is excluded because the seed never
// created it (clashed with pre-existing `organization.go_live`).
const SEEDED_FIELDS_TO_DELETE = [
  { scope: 'organization', name: 'region' },
  { scope: 'organization', name: 'org_legal_type' },
  { scope: 'organization', name: 'total_schools' },
  { scope: 'organization', name: 'children_impacted_direct' },
  { scope: 'organization', name: 'children_impacted_indirect' },
];

async function run() {
  console.log(`[unseed] Target tenant: ${GFI_TENANT_ID}`);

  // 1) Find seeded shared widgets by title.
  const { data: matches, error: mErr } = await sb
    .from('dashboard_widget')
    .select('id,title,scope,created_at,created_by')
    .eq('tenant_id', GFI_TENANT_ID)
    .eq('scope', 'shared')
    .in('title', SEED_WIDGET_TITLES);
  if (mErr) throw mErr;

  console.log(`\n[unseed] Found ${matches.length} seeded shared widget(s) to delete:`);
  for (const w of matches) console.log(`  - ${w.id}  "${w.title}"`);

  if (matches.length > 0) {
    const ids = matches.map(w => w.id);
    const { error: delWErr } = await sb
      .from('dashboard_widget')
      .delete()
      .in('id', ids);
    if (delWErr) throw delWErr;
    console.log(`[unseed] Deleted ${ids.length} dashboard_widget row(s).`);
  }

  // 2) Delete seed-created preference_field rows by (tenant_id, scope, name).
  let deletedFields = 0;
  for (const f of SEEDED_FIELDS_TO_DELETE) {
    const { data: rows, error } = await sb
      .from('preference_field')
      .select('id,name,entity_scope,created_at')
      .eq('tenant_id', GFI_TENANT_ID)
      .eq('entity_scope', f.scope)
      .eq('name', f.name);
    if (error) throw error;
    if (rows.length === 0) {
      console.log(`[unseed] (skip) ${f.scope}.${f.name} — no row found`);
      continue;
    }
    const ids = rows.map(r => r.id);
    const { error: dErr } = await sb
      .from('preference_field')
      .delete()
      .in('id', ids);
    if (dErr) throw dErr;
    deletedFields += ids.length;
    console.log(`[unseed] Deleted ${f.scope}.${f.name} (${ids.length} row(s))`);
  }
  console.log(`[unseed] Deleted ${deletedFields} preference_field row(s) total.`);

  // 3) Verify untouched data still present.
  const { count: personalLeft } = await sb
    .from('dashboard_widget')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', GFI_TENANT_ID)
    .eq('scope', 'personal');
  console.log(`[unseed] GFI personal widgets remaining (untouched): ${personalLeft}`);

  const { data: ogv } = await sb
    .from('preference_field')
    .select('id,entity_scope,name')
    .eq('tenant_id', GFI_TENANT_ID)
    .eq('entity_scope', 'organization')
    .eq('name', 'go_live');
  console.log(`[unseed] Pre-existing organization.go_live preserved:`, ogv);

  const { data: ot } = await sb
    .from('preference_field')
    .select('id,entity_scope,name,created_at')
    .eq('tenant_id', GFI_TENANT_ID)
    .eq('entity_scope', 'organization')
    .eq('name', 'org_type');
  console.log(`[unseed] Pre-existing organization.org_type preserved:`, ot);

  console.log('\n[unseed] Complete.');
}

run().catch(err => {
  console.error('[unseed] Failed:', err);
  process.exit(1);
});
