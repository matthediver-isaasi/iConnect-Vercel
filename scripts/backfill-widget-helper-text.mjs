// Backfill helper text (the ⓘ popover) onto existing dashboard widgets.
//
// For every dashboard_widget whose config has no helperText, generates a
// deterministic plain-language description of what the widget shows
// (shared/widgetDescriber.js) and stores it in config.helperText.
//
// - Dry-run by default; pass --apply to write.
// - Optional --tenant=<uuid> to restrict to one tenant.
// - Never overwrites an existing non-empty helperText (user-authored or
//   previously backfilled) — safe to re-run.
//
// Usage:
//   node scripts/backfill-widget-helper-text.mjs            # dry run, all tenants
//   node scripts/backfill-widget-helper-text.mjs --apply
//   node scripts/backfill-widget-helper-text.mjs --tenant=<uuid> --apply

import { createClient } from '@supabase/supabase-js';
import { describeWidgetConfig } from '../shared/widgetDescriber.js';
import { DASHBOARD_SOURCES } from '../api/dashboard/_lib/sources.js';

const APPLY = process.argv.includes('--apply');
const tenantArg = process.argv.find(a => a.startsWith('--tenant='));
const TENANT = tenantArg ? tenantArg.split('=')[1] : null;

const url = process.env.DEST_SUPABASE_URL;
const key = process.env.DEST_SUPABASE_KEY;
if (!url || !key) {
  console.error('Missing DEST_SUPABASE_URL / DEST_SUPABASE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

async function fetchAllWidgets() {
  const out = [];
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    let q = sb
      .from('dashboard_widget')
      .select('id, tenant_id, title, widget_type, config')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (TENANT) q = q.eq('tenant_id', TENANT);
    const { data, error } = await q;
    if (error) throw new Error(`Fetch widgets failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// form id -> name lookup, per tenant lazily (for DD form_id filters).
const formCache = new Map();
async function formNames(tenantId) {
  if (formCache.has(tenantId)) return formCache.get(tenantId);
  const map = new Map();
  const { data, error } = await sb
    .from('form')
    .select('id, name')
    .eq('tenant_id', tenantId);
  if (error) {
    console.warn(`  ! form lookup failed for tenant ${tenantId}: ${error.message}`);
  }
  for (const f of data || []) map.set(f.id, f.name || null);
  formCache.set(tenantId, map);
  return map;
}

// preference_field id -> label lookup, per tenant lazily.
const prefCache = new Map();
async function prefLabels(tenantId) {
  if (prefCache.has(tenantId)) return prefCache.get(tenantId);
  const map = new Map();
  const { data, error } = await sb
    .from('preference_field')
    .select('id, name, label')
    .eq('tenant_id', tenantId);
  if (error) {
    console.warn(`  ! preference_field lookup failed for tenant ${tenantId}: ${error.message}`);
  }
  for (const f of data || []) map.set(f.id, f.label || f.name || null);
  prefCache.set(tenantId, map);
  return map;
}

function systemLabel(sourceId, fieldName) {
  const def = DASHBOARD_SOURCES[sourceId];
  const f = (def?.systemFields || []).find(s => s.name === fieldName);
  return f?.label || null;
}

async function main() {
  const widgets = await fetchAllWidgets();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${widgets.length} widget(s)${TENANT ? ` (tenant ${TENANT})` : ''}`);

  let updated = 0;
  let skipped = 0;
  for (const w of widgets) {
    const config = w.config || {};
    if (typeof config.helperText === 'string' && config.helperText.trim() !== '') {
      skipped++;
      continue;
    }
    const custom = await prefLabels(w.tenant_id);
    const fieldLabel = ref => {
      if (!ref) return null;
      const kind = ref.fieldKind || ref.kind;
      if (kind === 'custom') return ref.fieldId ? custom.get(ref.fieldId) || null : null;
      return ref.field ? systemLabel(config.source, ref.field) : null;
    };
    const forms = await formNames(w.tenant_id);
    const valueLabel = (ref, value) => {
      // Resolve DD form UUIDs to the form's name.
      if ((ref.fieldKind || ref.kind) !== 'custom' && ref.field === 'form_id') {
        return forms.get(value) || null;
      }
      return null;
    };
    const sourceLabel = DASHBOARD_SOURCES[config.source]?.label || 'records';
    const text = describeWidgetConfig(config, {
      widgetType: w.widget_type,
      sourceLabel,
      fieldLabel,
      valueLabel,
    }).slice(0, 1000);
    if (!text) {
      console.log(`- skip (no description): ${w.id} "${w.title}"`);
      skipped++;
      continue;
    }
    console.log(`- ${w.id} "${w.title}"\n    → ${text}`);
    if (APPLY) {
      const { error } = await sb
        .from('dashboard_widget')
        .update({ config: { ...config, helperText: text } })
        .eq('id', w.id);
      if (error) {
        console.error(`  ! update failed: ${error.message}`);
        continue;
      }
    }
    updated++;
  }
  console.log(`\nDone. ${updated} ${APPLY ? 'updated' : 'would update'}, ${skipped} skipped (already have text or no description).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
