#!/usr/bin/env node
/**
 * Seed the three "DD by status" pie widgets onto the shared dashboard
 * for a single hard-pinned tenant (task #1088). The pies group DD
 * submissions by canonical workflow_status, partitioned by DD form:
 *   - ESO Due Diligence by status (filtered to the "ESO Long form")
 *   - SO Due Diligence by status (filtered to the "SO Long form")
 *   - Total Due Diligence by status (no form filter)
 *
 * The ESO / SO pies filter by `form_id` (not `org_type`) so their counts
 * match the per-form view on /DueDiligenceDashboard, which scopes to a
 * single form. An org_type filter counted every org of that type across
 * all forms, which over/under-counted versus the form view. Re-running
 * this script also reconciles any existing pies still using the old
 * org_type filter onto the form-based config.
 *
 * Tenant-pinned by design: this surface only makes sense for the
 * specified tenant's data shape. Refuses any other TENANT_ID so the
 * script can't be mis-targeted at another tenant in a shared shell.
 *
 * Idempotent: skips any pie whose title already exists at shared scope.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/seed-dd-status-widgets.mjs
 */

import { createClient } from '@supabase/supabase-js';

const ALLOWED_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const TENANT_ID = process.env.TENANT_ID || ALLOWED_TENANT_ID;

if (TENANT_ID !== ALLOWED_TENANT_ID) {
  console.error(
    `[seed-dd-status-widgets] Refusing to run for tenant ${TENANT_ID}. ` +
    `This seed is hard-pinned to ${ALLOWED_TENANT_ID}.`,
  );
  process.exit(1);
}

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_KEY ||
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[seed-dd-status-widgets] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// DD form ids for this tenant (confirmed via probe). The eq filter is a
// literal string match on the flattened DD row's form_id, matching the
// single-form scoping the /DueDiligenceDashboard view uses.
const ESO_FORM_ID = 'a9ec1559-495a-4705-9da9-d51517be7bb6'; // "ESO Long form"
const SO_FORM_ID = 'dd04a19b-019b-4cb2-9a7f-3a77027e9857'; // "SO Long form"

function buildPie({ title, displayOrder, formFilter }) {
  const filters = formFilter
    ? [{ fieldKind: 'system', field: 'form_id', operator: 'eq', value: formFilter }]
    : [];
  return {
    title,
    widget_type: 'pie',
    width: 'third',
    display_order: displayOrder,
    config: {
      source: 'dd_submission',
      measure: { aggregator: 'count', field: null, fieldKind: null, fieldId: null },
      groupBy: { kind: 'system', field: 'workflow_status', fieldId: null },
      filters,
    },
  };
}

const WIDGETS = [
  buildPie({ title: 'DD by status — ESO', displayOrder: 1000, formFilter: ESO_FORM_ID }),
  buildPie({ title: 'DD by status — SO', displayOrder: 1001, formFilter: SO_FORM_ID }),
  buildPie({ title: 'DD by status — Total', displayOrder: 1002, formFilter: null }),
];

// Legacy titles from earlier seed runs of this script. We rename in
// place so the dashboard doesn't end up with both the old and new
// titles after the title rename. Idempotent: harmless if no rows match.
const LEGACY_TITLE_RENAMES = [
  { from: 'ESO Due Diligence by status', to: 'DD by status — ESO' },
  { from: 'SO Due Diligence by status', to: 'DD by status — SO' },
  { from: 'Total Due Diligence by status', to: 'DD by status — Total' },
];

async function renameLegacyTitles() {
  for (const { from, to } of LEGACY_TITLE_RENAMES) {
    const { data, error } = await supabase
      .from('dashboard_widget')
      .update({ title: to })
      .eq('tenant_id', TENANT_ID)
      .eq('scope', 'shared')
      .eq('title', from)
      .select('id');
    if (error) throw error;
    if (data && data.length > 0) {
      console.log(`  ↻ renamed "${from}" → "${to}"`);
    }
  }
}

// Reconcile any already-seeded pies onto the current config. Existing
// rows are skipped by the insert path (idempotency keys on title), so
// migrating the ESO/SO pies off the old org_type filter onto the
// form_id filter has to happen here. Writing the same config twice is a
// no-op, so this is safe to re-run.
async function reconcileWidgetConfigs(existingTitles) {
  for (const w of WIDGETS) {
    if (!existingTitles.has(w.title)) continue;
    const { data, error } = await supabase
      .from('dashboard_widget')
      .update({ config: w.config })
      .eq('tenant_id', TENANT_ID)
      .eq('scope', 'shared')
      .eq('title', w.title)
      .select('id');
    if (error) throw error;
    if (data && data.length > 0) {
      console.log(`  ↻ reconciled config for "${w.title}"`);
    }
  }
}

async function main() {
  console.log(`Seeding DD status widgets for tenant ${TENANT_ID}\n`);
  await renameLegacyTitles();

  const { data: existing, error: existingErr } = await supabase
    .from('dashboard_widget')
    .select('title')
    .eq('tenant_id', TENANT_ID)
    .eq('scope', 'shared');
  if (existingErr) throw existingErr;
  const existingTitles = new Set((existing || []).map(w => w.title));

  await reconcileWidgetConfigs(existingTitles);

  const toInsert = WIDGETS
    .filter(w => !existingTitles.has(w.title))
    .map(w => ({
      tenant_id: TENANT_ID,
      scope: 'shared',
      owner_member_id: null,
      title: w.title,
      widget_type: w.widget_type,
      width: w.width,
      config: w.config,
      display_order: w.display_order,
      created_by: null,
    }));

  WIDGETS
    .filter(w => existingTitles.has(w.title))
    .forEach(w => console.log(`  ✓ "${w.title}" already exists`));

  if (toInsert.length === 0) {
    console.log('\nNothing to insert.');
    return;
  }

  const { error: insertErr } = await supabase.from('dashboard_widget').insert(toInsert);
  if (insertErr) throw insertErr;
  toInsert.forEach(w => console.log(`  + inserted "${w.title}"`));
  console.log('\nDone.');
}

main().catch(err => {
  console.error('[seed-dd-status-widgets] Failed:', err.message || err);
  process.exit(1);
});
