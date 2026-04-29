#!/usr/bin/env node
/**
 * Seed default dashboard widgets for a tenant (task #607).
 *
 * Idempotent in two phases:
 *   1. Ensure custom preference_field rows exist (region, org_type,
 *      total_schools, children_impacted_direct, children_impacted_indirect,
 *      member.go_live).
 *   2. Insert curated shared widgets, skipping any whose title already
 *      exists at shared scope.
 *
 * Usage:
 *   TENANT_ID=fd82da65-aab7-4a5c-85b8-b2febeb2003d \
 *   DEST_SUPABASE_URL=... DEST_SUPABASE_SERVICE_KEY=... \
 *   node scripts/seed-default-dashboard-widgets.mjs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  process.env.DEST_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  process.env.DEV_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.DEST_SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.DEV_SUPABASE_SERVICE_KEY;
const TENANT_ID = process.env.TENANT_ID || 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[seed-widgets] Missing Supabase credentials.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CURRENT_YEAR_START = `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;

const REQUIRED_FIELDS = [
  {
    name: 'region',
    label: 'Region',
    field_type: 'dropdown',
    entity_scope: 'organization',
    options: [
      { value: 'africa', label: 'Africa' },
      { value: 'asia', label: 'Asia' },
      { value: 'latin_america', label: 'Latin America' },
      { value: 'multi_regions', label: 'Multi-regions' },
    ],
  },
  {
    // Membership class: ESO / SO / School. Kept as `org_type` because
    // existing seed data and downstream filters already use that name.
    name: 'org_type',
    label: 'Organisation type',
    field_type: 'dropdown',
    entity_scope: 'organization',
    options: [
      { value: 'eso', label: 'ESO' },
      { value: 'so', label: 'SO' },
      { value: 'school', label: 'School' },
    ],
  },
  {
    // Legal type: Non-profit / For-profit — orthogonal to membership
    // class so an ESO can also be tagged as non-profit, etc. The pie
    // breakdown widget uses this dimension.
    name: 'org_legal_type',
    label: 'Legal type',
    field_type: 'dropdown',
    entity_scope: 'organization',
    options: [
      { value: 'non_profit', label: 'Non-profit' },
      { value: 'for_profit', label: 'For-profit' },
    ],
  },
  {
    name: 'total_schools',
    label: 'Total schools',
    field_type: 'number',
    entity_scope: 'organization',
    options: null,
  },
  {
    name: 'children_impacted_direct',
    label: 'Children impacted (direct)',
    field_type: 'number',
    entity_scope: 'organization',
    options: null,
  },
  {
    name: 'children_impacted_indirect',
    label: 'Children impacted (indirect)',
    field_type: 'number',
    entity_scope: 'organization',
    options: null,
  },
  {
    name: 'go_live',
    label: 'Go-live date',
    field_type: 'date',
    entity_scope: 'member',
    options: null,
  },
];

function mergeOptions(existing, required) {
  // Preserves any custom options the tenant already added, then appends
  // any required option whose `value` is missing. We intentionally do
  // NOT relabel existing matching options — the tenant may have
  // localised them and we don't want to overwrite their labels.
  const arr = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(arr.map(o => o?.value).filter(v => v !== undefined && v !== null));
  let added = 0;
  for (const opt of required || []) {
    if (!seen.has(opt.value)) {
      arr.push(opt);
      seen.add(opt.value);
      added += 1;
    }
  }
  return { merged: arr, added };
}

async function ensurePreferenceFields() {
  const ids = {};
  for (const spec of REQUIRED_FIELDS) {
    const { data: existing, error: lookupErr } = await supabase
      .from('preference_field')
      .select('id, name, label, field_type, entity_scope, options')
      .eq('tenant_id', TENANT_ID)
      .eq('entity_scope', spec.entity_scope)
      .eq('name', spec.name)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (existing) {
      ids[`${spec.entity_scope}.${spec.name}`] = existing.id;
      // For dropdown fields make sure every required option exists,
      // upserting any that the admin removed or never had — otherwise
      // seeded widgets that filter on those values silently match
      // nothing.
      if (spec.field_type === 'dropdown' && Array.isArray(spec.options)) {
        const { merged, added } = mergeOptions(existing.options, spec.options);
        if (added > 0) {
          const { error: updErr } = await supabase
            .from('preference_field')
            .update({ options: merged })
            .eq('id', existing.id);
          if (updErr) throw updErr;
          console.log(`  ↻ ${spec.entity_scope}.${spec.name} exists; merged ${added} missing option(s)`);
        } else {
          console.log(`  ✓ ${spec.entity_scope}.${spec.name} already exists`);
        }
      } else {
        console.log(`  ✓ ${spec.entity_scope}.${spec.name} already exists`);
      }
      continue;
    }
    const { data: inserted, error: insertErr } = await supabase
      .from('preference_field')
      .insert({
        tenant_id: TENANT_ID,
        name: spec.name,
        label: spec.label,
        field_type: spec.field_type,
        entity_scope: spec.entity_scope,
        is_active: true,
        options: spec.options,
      })
      .select('id')
      .single();
    if (insertErr) throw insertErr;
    console.log(`  + created ${spec.entity_scope}.${spec.name}`);
    ids[`${spec.entity_scope}.${spec.name}`] = inserted.id;
  }
  return ids;
}

function orgTypeFilter(orgTypeFieldId, value) {
  return {
    fieldKind: 'custom',
    field: 'org_type',
    fieldId: orgTypeFieldId,
    operator: 'eq',
    value,
  };
}

function currentYearFilter() {
  return {
    fieldKind: 'system',
    field: 'created_at',
    fieldId: null,
    operator: 'gte',
    value: CURRENT_YEAR_START,
  };
}

function memberCurrentYearGoLiveFilter(goLiveFieldId) {
  return {
    fieldKind: 'custom',
    field: 'go_live',
    fieldId: goLiveFieldId,
    operator: 'gte',
    value: CURRENT_YEAR_START,
  };
}

function buildWidgets(fieldIds) {
  const orgRegion = fieldIds['organization.region'];
  const orgType = fieldIds['organization.org_type'];
  const orgLegalType = fieldIds['organization.org_legal_type'];
  const orgTotalSchools = fieldIds['organization.total_schools'];
  const orgChildrenDirect = fieldIds['organization.children_impacted_direct'];
  const orgChildrenIndirect = fieldIds['organization.children_impacted_indirect'];
  const memberGoLive = fieldIds['member.go_live'];

  return [
    // Top-row KPIs (5 stat cards, width: 'fifth' → 5 across the 12-col grid).
    {
      title: 'Total ESOs',
      widget_type: 'stat',
      width: 'fifth',
      display_order: 10,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: null,
        filters: [orgTypeFilter(orgType, 'eso')],
      },
    },
    {
      title: 'Total SOs',
      widget_type: 'stat',
      width: 'fifth',
      display_order: 20,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: null,
        filters: [orgTypeFilter(orgType, 'so')],
      },
    },
    {
      title: 'Total Schools',
      widget_type: 'stat',
      width: 'fifth',
      display_order: 30,
      config: {
        source: 'organization',
        measure: {
          aggregator: 'sum',
          field: 'total_schools',
          fieldKind: 'custom',
          fieldId: orgTotalSchools,
        },
        groupBy: null,
        timeBucket: null,
        filters: [],
      },
    },
    {
      title: 'Children Impacted (direct + indirect)',
      widget_type: 'stat',
      width: 'fifth',
      display_order: 40,
      config: {
        // Combined sum across two custom fields via measure.additionalFields
        // — the engine adds (direct + indirect) per row before the sum
        // aggregator runs across rows.
        source: 'organization',
        measure: {
          aggregator: 'sum',
          field: 'children_impacted_direct',
          fieldKind: 'custom',
          fieldId: orgChildrenDirect,
          additionalFields: [
            {
              field: 'children_impacted_indirect',
              fieldKind: 'custom',
              fieldId: orgChildrenIndirect,
            },
          ],
        },
        groupBy: null,
        timeBucket: null,
        filters: [],
      },
    },
    {
      title: 'Unique LMIC countries',
      widget_type: 'stat',
      width: 'fifth',
      display_order: 50,
      config: {
        source: 'organization',
        measure: {
          aggregator: 'count_distinct',
          field: 'country',
          fieldKind: 'system',
          fieldId: null,
        },
        groupBy: null,
        timeBucket: null,
        filters: [
          { fieldKind: 'system', field: 'country', fieldId: null, operator: 'lmic', value: null },
        ],
      },
    },

    // Time-series bars (current-year scope).
    {
      title: 'New ESOs by month (current year)',
      widget_type: 'bar',
      width: 'half',
      display_order: 60,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: { field: 'created_at', granularity: 'month' },
        filters: [orgTypeFilter(orgType, 'eso'), currentYearFilter()],
      },
    },
    {
      title: 'New ESOs by quarter (current year)',
      widget_type: 'bar',
      width: 'half',
      display_order: 70,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: { field: 'created_at', granularity: 'quarter' },
        filters: [orgTypeFilter(orgType, 'eso'), currentYearFilter()],
      },
    },
    {
      title: 'New SOs by month (current year)',
      widget_type: 'bar',
      width: 'half',
      display_order: 80,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: { field: 'created_at', granularity: 'month' },
        filters: [orgTypeFilter(orgType, 'so'), currentYearFilter()],
      },
    },
    {
      title: 'New SOs by quarter (current year)',
      widget_type: 'bar',
      width: 'half',
      display_order: 90,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: { field: 'created_at', granularity: 'quarter' },
        filters: [orgTypeFilter(orgType, 'so'), currentYearFilter()],
      },
    },
    {
      title: 'New approved members by month (current year)',
      widget_type: 'bar',
      width: 'half',
      display_order: 100,
      config: {
        // Buckets on member.go_live (custom date) — the engine reads
        // custom date timeBuckets through the preference store.
        source: 'member',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: {
          field: 'go_live',
          fieldKind: 'custom',
          fieldId: memberGoLive,
          granularity: 'month',
        },
        filters: [memberCurrentYearGoLiveFilter(memberGoLive)],
      },
    },
    {
      title: 'New schools by month (current year)',
      widget_type: 'bar',
      width: 'half',
      display_order: 110,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: null,
        timeBucket: { field: 'created_at', granularity: 'month' },
        filters: [orgTypeFilter(orgType, 'school'), currentYearFilter()],
      },
    },

    // Pie breakdowns.
    {
      title: 'Organisations by region',
      widget_type: 'pie',
      width: 'half',
      display_order: 120,
      config: {
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: { kind: 'custom', field: 'region', fieldId: orgRegion },
        timeBucket: null,
        filters: [],
      },
    },
    {
      title: 'Organisations by legal type (Non-profit vs For-profit)',
      widget_type: 'pie',
      width: 'half',
      display_order: 130,
      config: {
        // Groups on org_legal_type — a separate dropdown from
        // org_type — so an organisation's membership class
        // (ESO/SO/School) and legal type are tracked independently.
        source: 'organization',
        measure: { aggregator: 'count', field: 'id', fieldKind: 'system', fieldId: null },
        groupBy: { kind: 'custom', field: 'org_legal_type', fieldId: orgLegalType },
        timeBucket: null,
        filters: [],
      },
    },
  ];
}

async function seedWidgets(widgets) {
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

  if (toInsert.length === 0) {
    console.log('  ✓ all widgets already present');
    return;
  }
  const { error: insertErr } = await supabase.from('dashboard_widget').insert(toInsert);
  if (insertErr) throw insertErr;
  toInsert.forEach(w => console.log(`  + inserted "${w.title}"`));
}

(async function main() {
  console.log(`Seeding default dashboard widgets for tenant ${TENANT_ID}\n`);
  console.log('Step 1: ensure preference fields…');
  const fieldIds = await ensurePreferenceFields();
  console.log('\nStep 2: seed shared widgets…');
  await seedWidgets(buildWidgets(fieldIds));
  console.log('\nDone.');
})().catch(err => {
  console.error('[seed-widgets] Failed:', err.message || err);
  process.exit(1);
});
