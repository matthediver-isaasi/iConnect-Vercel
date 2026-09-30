#!/usr/bin/env node
// Seed the two "NOT LMIC" dashboard widgets for the tenant that owns the
// existing LMIC pair. Idempotent: skips creation when a widget with the
// same title already exists for the tenant. Dry-run by default; pass
// --apply to write.
//
// The widgets mirror the existing pair ("Unique countries of operation
// LMIC" / "... LMIC by Regions") exactly, with the `lmic` filter operator
// swapped for `not_lmic`. Configs are copied from the LIVE rows so any
// tweaks the admin made (extra filters, colors) carry over.
//
// Usage: node scripts/seed-not-lmic-widgets.mjs [--apply]

import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '21296ad6-1350-483a-a90c-1b06ece70501';
const SOURCE_TITLES = {
  'Unique countries of operation LMIC': 'Unique countries of operation NOT LMIC',
  'Unique countries of operation LMIC by Regions': 'Unique countries of operation NOT LMIC by Regions',
};

const apply = process.argv.includes('--apply');

const supabase = createClient(
  process.env.DEST_SUPABASE_URL,
  process.env.DEST_SUPABASE_KEY,
  { auth: { persistSession: false } },
);

function invertConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  copy.filters = (copy.filters || []).map(f =>
    f.operator === 'lmic' ? { ...f, operator: 'not_lmic' } : f,
  );
  return copy;
}

const { data: existing, error } = await supabase
  .from('dashboard_widget')
  .select('*')
  .eq('tenant_id', TENANT_ID)
  .in('title', [...Object.keys(SOURCE_TITLES), ...Object.values(SOURCE_TITLES)]);
if (error) {
  console.error('Failed to load widgets:', error.message);
  process.exit(1);
}

const byTitle = new Map((existing || []).map(w => [w.title, w]));
const { data: orderRows } = await supabase
  .from('dashboard_widget')
  .select('display_order')
  .eq('tenant_id', TENANT_ID)
  .order('display_order', { ascending: false })
  .limit(1);
let nextOrder = ((orderRows && orderRows[0]?.display_order) || 0) + 1;

for (const [srcTitle, newTitle] of Object.entries(SOURCE_TITLES)) {
  const src = byTitle.get(srcTitle);
  if (!src) {
    console.warn(`SKIP: source widget "${srcTitle}" not found for tenant.`);
    continue;
  }
  if (byTitle.get(newTitle)) {
    console.log(`SKIP: "${newTitle}" already exists.`);
    continue;
  }
  const row = {
    tenant_id: TENANT_ID,
    scope: src.scope,
    owner_member_id: src.owner_member_id,
    title: newTitle,
    widget_type: src.widget_type,
    width: src.width,
    config: invertConfig(src.config),
    display_order: nextOrder++,
    created_by: src.created_by,
  };
  if (!apply) {
    console.log(`DRY RUN: would create "${newTitle}":`, JSON.stringify(row.config.filters));
    continue;
  }
  const { error: insErr } = await supabase.from('dashboard_widget').insert(row);
  if (insErr) {
    console.error(`FAILED to create "${newTitle}":`, insErr.message);
    process.exit(1);
  }
  console.log(`Created "${newTitle}".`);
}
console.log(apply ? 'Done.' : 'Dry run complete. Re-run with --apply to write.');
