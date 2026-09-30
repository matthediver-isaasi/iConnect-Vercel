#!/usr/bin/env node
/**
 * Seed three "live ESO/SO members" dashboard widgets for a single
 * hard-pinned tenant (the GSF tenant). Each widget uses the
 * `organization` source filtered to org_status='Active' AND
 * org_type IN ('ESO','SO'):
 *
 *   - Current students — live ESO/SO   (number, sum of `current_students`)
 *   - Profit status — live ESO/SO      (pie, count grouped by `trading_as`)
 *   - Cumulative students — live ESO/SO (number, sum of `cumulative_students`)
 *
 * Tenant-pinned by design: refuses to run for any other TENANT_ID.
 * Idempotent: skips any widget whose title already exists at shared
 * scope. Resolves preference_field UUIDs by name at runtime so the
 * script stays portable across reseeds of the same tenant.
 *
 * Usage:
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_KEY=... \
 *   node scripts/seed-gsf-membership-widgets.mjs
 */

import { createClient } from '@supabase/supabase-js';

const ALLOWED_TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const TENANT_ID = process.env.TENANT_ID || ALLOWED_TENANT_ID;

if (TENANT_ID !== ALLOWED_TENANT_ID) {
  console.error(
    `[seed-gsf-membership-widgets] Refusing to run for tenant ${TENANT_ID}. ` +
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
  console.error('[seed-gsf-membership-widgets] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function resolveFieldIds() {
  const names = ['org_status', 'org_type', 'trading_as', 'current_students', 'cumulative_students'];
  const { data, error } = await supabase
    .from('preference_field')
    .select('id, name')
    .eq('tenant_id', TENANT_ID)
    .eq('entity_scope', 'organization')
    .in('name', names);
  if (error) throw error;
  const byName = Object.fromEntries((data || []).map(r => [r.name, r.id]));
  const missing = names.filter(n => !byName[n]);
  if (missing.length > 0) {
    throw new Error(`Missing organization preference_field(s) for tenant ${TENANT_ID}: ${missing.join(', ')}`);
  }
  return byName;
}

function liveEsoSoFilters(fieldIds) {
  // org_status='Active' AND org_type IN ('ESO','SO'). Values are stored
  // exactly as written here (verified via probe).
  return [
    { fieldKind: 'custom', fieldId: fieldIds.org_status, operator: 'eq', value: 'Active' },
    { fieldKind: 'custom', fieldId: fieldIds.org_type, operator: 'in', value: ['ESO', 'SO'] },
  ];
}

function buildNumberSum({ title, displayOrder, sumFieldId, fieldIds }) {
  return {
    title,
    widget_type: 'stat',
    width: 'third',
    display_order: displayOrder,
    config: {
      source: 'organization',
      measure: { aggregator: 'sum', fieldKind: 'custom', fieldId: sumFieldId, field: null },
      filters: liveEsoSoFilters(fieldIds),
    },
  };
}

function buildProfitPie({ title, displayOrder, fieldIds }) {
  return {
    title,
    widget_type: 'pie',
    width: 'third',
    display_order: displayOrder,
    config: {
      source: 'organization',
      measure: { aggregator: 'count', field: null, fieldKind: null, fieldId: null },
      groupBy: { kind: 'custom', field: null, fieldId: fieldIds.trading_as },
      filters: liveEsoSoFilters(fieldIds),
    },
  };
}

async function main() {
  console.log(`Seeding GSF membership widgets for tenant ${TENANT_ID}\n`);

  const fieldIds = await resolveFieldIds();
  console.log('Resolved preference_field UUIDs:');
  for (const [k, v] of Object.entries(fieldIds)) console.log(`  ${k.padEnd(22)} ${v}`);

  const widgets = [
    buildNumberSum({
      title: 'Current students — live ESO/SO',
      displayOrder: 1100,
      sumFieldId: fieldIds.current_students,
      fieldIds,
    }),
    buildProfitPie({
      title: 'Profit status — live ESO/SO',
      displayOrder: 1101,
      fieldIds,
    }),
    buildNumberSum({
      title: 'Cumulative students — live ESO/SO',
      displayOrder: 1102,
      sumFieldId: fieldIds.cumulative_students,
      fieldIds,
    }),
  ];

  const { data: existing, error: existingErr } = await supabase
    .from('dashboard_widget')
    .select('title')
    .eq('tenant_id', TENANT_ID)
    .eq('scope', 'shared');
  if (existingErr) throw existingErr;
  const existingTitles = new Set((existing || []).map(w => w.title));

  const toInsert = widgets
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

  widgets
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
  console.error('[seed-gsf-membership-widgets] Failed:', err.message || err);
  process.exit(1);
});
