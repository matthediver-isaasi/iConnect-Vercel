import { supabase } from '../../_lib/database.js';
import { tenantFilter } from './permissions.js';
import {
  regionBucketsForScheme,
  REGION_SCHEME_APP,
  REGION_SCHEME_WORLD_BANK,
} from '../../../shared/countryRegions.js';

// Derived dimension: world region classified from the source's
// `countries`-typed multi-country preference field(s). Not a stored
// column — the aggregation engine computes each row's bucket at query
// time via shared/countryRegions.js (one region → its name, several →
// "Multi-region", none/unresolvable → "Unknown").
// `derived` keeps it out of the SQL column selection; `groupOnly` tells
// the builder to exclude it from the measure and time-bucket pickers (it
// can't be measured or time-bucketed — no stored column), while
// `filterable` re-admits it into the filter picker: the engine applies
// region filters in JS after per-row bucket derivation. `regionSchemes`
// publishes the available classification schemes (each with its own
// bucket list) so the builder can render a scheme picker for both the
// group-by and filter surfaces; `options` stays the app-scheme bucket
// list for backwards compatibility.
function buildRegionField() {
  const schemes = [
    { value: REGION_SCHEME_APP, label: 'App regions' },
    { value: REGION_SCHEME_WORLD_BANK, label: 'World Bank regions' },
  ].map(s => ({
    ...s,
    options: regionBucketsForScheme(s.value).map(b => ({ value: b, label: b })),
  }));
  return {
    name: 'region',
    label: 'Region',
    type: 'enum',
    derived: 'region',
    groupOnly: true,
    filterable: true,
    options: regionBucketsForScheme(REGION_SCHEME_APP).map(b => ({ value: b, label: b })),
    regionSchemes: schemes,
  };
}

/**
 * Source registry for the dashboard widget builder.
 *
 * Each source describes a queryable entity. `systemFields` are the static
 * built-in columns. Custom fields are discovered at runtime from the
 * preference_field table for the current tenant.
 *
 * The `aggregatable` flag controls whether a numeric field can be the
 * subject of sum/avg/min/max (otherwise only count is allowed).
 */
export const DASHBOARD_SOURCES = {
  organization: {
    id: 'organization',
    label: 'Organisations',
    table: 'organization',
    timestampField: 'created_at',
    preferenceTable: 'organization_preference_value',
    preferenceFkColumn: 'organization_id',
    preferenceScope: 'organization',
    systemFields: [
      { name: 'id', label: 'ID', type: 'id' },
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'domain', label: 'Domain', type: 'text' },
      // `country` is exposed so the LMIC filter operator and the
      // count_distinct(country) measure used by seeded widgets can be
      // configured from the builder against organization.country.
      // `isCountry` tells the aggregation engine to normalise group-by
      // buckets through the shared country resolver (ISO-2 bucketing,
      // display names) even without an LMIC filter.
      { name: 'country', label: 'Country', type: 'text', isCountry: true },
      buildRegionField(),
      { name: 'created_at', label: 'Created at', type: 'date' },
      { name: 'last_synced', label: 'Last synced', type: 'date' },
      { name: 'training_fund_balance', label: 'Training fund balance', type: 'number', aggregatable: true },
      { name: 'guest_access_period_days', label: 'Guest access period (days)', type: 'number', aggregatable: true },
      { name: 'guest_access_enabled', label: 'Guest access enabled', type: 'boolean' },
      { name: 'guest_access_unlimited', label: 'Guest access unlimited', type: 'boolean' },
      { name: 'purchase_order_enabled', label: 'Purchase order enabled', type: 'boolean' },
    ],
  },
  dd_submission: {
    id: 'dd_submission',
    label: 'Due Diligence Submissions',
    table: 'form_submission_due_diligence',
    timestampField: 'created_at',
    // DD submissions have no preference store of their own — custom
    // fields are not surfaced here. All filtering/grouping uses the
    // built-in systemFields below, which the aggregation engine
    // resolves via a dedicated DD code path (joins form_submission +
    // organization_preference_value for org_type).
    isDd: true,
    systemFields: [
      { name: 'id', label: 'ID', type: 'id' },
      {
        name: 'workflow_status',
        label: 'Status',
        type: 'enum',
        // The 7 canonical DD statuses. The aggregation engine
        // canonicalises each stored workflow_status (stage UUID OR
        // label string) before grouping/filtering, so picking any of
        // these as a filter/group value matches consistently across
        // forms.
        // Includes Approved alongside the 7 canonical statuses so the
        // builder dropdown exactly matches what the aggregator can emit
        // — DD forms that pass Verified into an explicit Approved stage
        // (e.g. gsf) would otherwise have rows showing in pies under a
        // bucket the builder couldn't filter on.
        options: [
          { value: 'New', label: 'New' },
          { value: 'In Review', label: 'In Review' },
          { value: 'Verified', label: 'Verified' },
          { value: 'DD Meet Attended', label: 'DD Meet Attended' },
          { value: 'Held', label: 'Held' },
          { value: 'Approved', label: 'Approved' },
          { value: 'Rejected', label: 'Rejected' },
          { value: 'Incomplete', label: 'Incomplete' },
        ],
      },
      { name: 'organization_id', label: 'Organisation', type: 'reference', referenceTable: 'organization' },
      { name: 'form_id', label: 'Form', type: 'reference' },
      {
        name: 'org_type',
        label: 'Organisation type',
        type: 'enum',
        // Joined from organization_preference_value; values are
        // whatever the tenant's org_type dropdown defines.
        options: null,
      },
      { name: 'submitted_at', label: 'Submitted at', type: 'date' },
      { name: 'created_at', label: 'Created at', type: 'date' },
      {
        // Synthetic, history-derived date dimension. Has no stored column;
        // the aggregator resolves each submission's value to the timestamp it
        // first entered the chosen workflow stage (carried on the time-bucket /
        // filter field config as `stage`). `stageField: true` tells the builder
        // to show a stage picker alongside it; `stageOptions` are the canonical
        // DD statuses (same list as workflow_status above).
        name: 'moved_to_stage',
        label: 'Date moved to stage…',
        type: 'date',
        stageField: true,
        stageOptions: [
          { value: 'New', label: 'New' },
          { value: 'In Review', label: 'In Review' },
          { value: 'Verified', label: 'Verified' },
          { value: 'DD Meet Attended', label: 'DD Meet Attended' },
          { value: 'Held', label: 'Held' },
          { value: 'Approved', label: 'Approved' },
          { value: 'Rejected', label: 'Rejected' },
          { value: 'Incomplete', label: 'Incomplete' },
        ],
      },
    ],
  },
  member: {
    id: 'member',
    label: 'Members',
    table: 'member',
    timestampField: 'created_on',
    preferenceTable: 'member_preference_value',
    preferenceFkColumn: 'member_id',
    preferenceScope: 'member',
    systemFields: [
      { name: 'id', label: 'ID', type: 'id' },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'role_id', label: 'Role', type: 'reference', referenceTable: 'role' },
      { name: 'organization_id', label: 'Organisation', type: 'reference', referenceTable: 'organization' },
      // Same derived Region dimension as the organisation source —
      // classified from the member's `countries`-typed preference
      // field(s) at query time.
      buildRegionField(),
      { name: 'login_enabled', label: 'Login enabled', type: 'boolean' },
      { name: 'show_in_directory', label: 'Show in directory', type: 'boolean' },
      { name: 'created_on', label: 'Created on', type: 'date' },
      { name: 'last_login', label: 'Last login', type: 'date' },
    ],
  },
  form_conversion: {
    id: 'form_conversion',
    label: 'Form conversion',
    table: 'form_submission',
    timestampField: 'created_date',
    // Bespoke two-form funnel source: the widget counts how many distinct
    // organisations / members submitted BOTH a source form and a target
    // form. Config lives under `config.conversion` and the aggregation
    // engine routes through its own code path — the generic measure /
    // group-by / time-bucket machinery does not apply.
    isConversion: true,
    systemFields: [
      // Exposed so admins can date-scope the funnel: filters on this
      // field apply to the TARGET form's submissions (a conversion only
      // counts when the target submission falls inside the range).
      { name: 'created_date', label: 'Submitted at (target form)', type: 'date' },
    ],
  },
};

/**
 * Returns serialisable source descriptors enriched with custom fields for
 * the supplied tenant. Falls back gracefully when preference lookups fail.
 */
/**
 * For the DD Submissions source, the `form_id` system field is a
 * reference with no fixed option set. The widget builder can't render a
 * meaningful picker without knowing the tenant's Due Diligence forms, so
 * we hydrate the field's `options` here with the tenant's DD-configured
 * forms (id + name). Only forms that have an active DD config are
 * returned — these are exactly the forms the aggregation engine counts.
 */
async function getDdFormOptions(tenantId) {
  if (!supabase || !tenantId) return [];
  try {
    const { data: configs, error: cfgErr } = await supabase
      .from('form_due_diligence_config')
      .select('form_id')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);
    if (cfgErr) throw cfgErr;
    const formIds = Array.from(
      new Set((configs || []).map(c => c.form_id).filter(Boolean)),
    );
    if (formIds.length === 0) return [];
    const { data: forms, error: formErr } = await supabase
      .from('form')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', formIds);
    if (formErr) throw formErr;
    return (forms || [])
      .map(f => ({ value: f.id, label: f.name || f.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    console.error('[Dashboard Sources] Failed to load DD form options:', err.message);
    return [];
  }
}

/**
 * Returns a copy of `systemFields` with dynamic, tenant-specific option
 * sets injected. Currently only the DD source's `form_id` field needs
 * this (its options are the tenant's DD forms). Other sources/fields are
 * returned unchanged.
 */
async function resolveSystemFields(def, tenantId) {
  if (!def.isDd) return def.systemFields;
  const formOptions = await getDdFormOptions(tenantId);
  return def.systemFields.map(f =>
    f.name === 'form_id' ? { ...f, options: formOptions } : f,
  );
}

/**
 * For the Form conversion source the builder needs the tenant's forms to
 * populate the source/target pickers. Returns id + name options sorted by
 * name; inactive forms are included because historic submissions still
 * count toward conversion.
 */
async function getTenantFormOptions(tenantId) {
  if (!supabase || !tenantId) return [];
  try {
    const { data, error } = await supabase
      .from('form')
      .select('id, name')
      .eq('tenant_id', tenantId);
    if (error) throw error;
    return (data || [])
      .map(f => ({ value: f.id, label: f.name || f.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (err) {
    console.error('[Dashboard Sources] Failed to load form options:', err.message);
    return [];
  }
}

// --- per-tenant hidden grouping fields ---------------------------------------
// Tenant admins can hide individual fields from the widget builder's option
// lists. The hidden set is stored as a JSON object in system_settings under
// this key, shaped { [sourceId]: ["system:<name>", "custom:<id>", ...] }.
// Enforcement happens here in the catalog (fields never reach the builder);
// the aggregation engine reads field definitions via getSourceDef /
// getCustomFieldsForSource, so widgets already configured with a hidden
// field keep rendering and aggregating.
export const HIDDEN_GROUP_FIELDS_KEY = 'dashboard_hidden_group_fields';

export function fieldOptionKey(field) {
  return field.isCustom ? `custom:${field.id}` : `system:${field.name}`;
}

export async function getHiddenGroupFields(tenantId) {
  if (!supabase) return {};
  try {
    let query = supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', HIDDEN_GROUP_FIELDS_KEY);
    query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null);
    const { data, error } = await query;
    if (error) throw error;
    const raw = data?.[0]?.setting_value;
    if (!raw) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [sourceId, keys] of Object.entries(parsed)) {
      if (Array.isArray(keys)) {
        out[sourceId] = keys.filter(k => typeof k === 'string');
      }
    }
    return out;
  } catch (err) {
    // Fail open: a broken/missing setting must never take the builder down.
    console.error('[Dashboard Sources] Failed to load hidden group fields:', err.message);
    return {};
  }
}

export async function getSourceCatalog(tenantId) {
  const sources = [];
  const hiddenBySource = await getHiddenGroupFields(tenantId);
  for (const def of Object.values(DASHBOARD_SOURCES)) {
    const hidden = new Set(hiddenBySource[def.id] || []);
    const customFields = (await getCustomFieldsForSource(def, tenantId))
      .filter(f => !hidden.has(`custom:${f.id}`));
    const systemFields = (await resolveSystemFields(def, tenantId))
      .filter(f => !hidden.has(`system:${f.name}`));
    sources.push({
      id: def.id,
      label: def.label,
      timestampField: def.timestampField,
      // Surfaced so the builder can offer DD-only capabilities (stage
      // transitions) without hard-coding the source id client-side.
      isDd: !!def.isDd,
      // Form-conversion capability flag + the tenant's forms for the
      // source/target pickers.
      isConversion: !!def.isConversion,
      ...(def.isConversion
        ? { forms: await getTenantFormOptions(tenantId) }
        : {}),
      systemFields,
      customFields,
    });
  }
  return sources;
}

/**
 * Returns the dynamic preference-field descriptors for a single source.
 * Used by both the catalog endpoint and the aggregation engine (which
 * needs to validate field types without re-querying the catalog).
 */
export async function getCustomFieldsForSource(sourceOrDef, tenantId) {
  const def = typeof sourceOrDef === 'string'
    ? DASHBOARD_SOURCES[sourceOrDef]
    : sourceOrDef;
  if (!def || !supabase) return [];
  // Sources without a preference store (e.g. DD Submissions) have no
  // tenant-defined custom fields to enumerate.
  if (!def.preferenceTable || !def.preferenceScope) return [];
  try {
    const baseQuery = supabase
      .from('preference_field')
      .select('id, name, label, field_type, options')
      .eq('entity_scope', def.preferenceScope)
      .eq('is_active', true);
    const { data, error } = await tenantFilter(baseQuery, tenantId);
    if (error) throw error;
    return (data || []).map(field => ({
      id: field.id,
      name: field.name,
      label: field.label || field.name,
      type: mapFieldType(field.field_type),
      fieldType: field.field_type,
      options: Array.isArray(field.options) ? field.options : null,
      aggregatable: ['number', 'decimal'].includes(field.field_type),
      isCustom: true,
    }));
  } catch (err) {
    console.error(`[Dashboard Sources] Failed to load custom fields for ${def.id}:`, err.message);
    return [];
  }
}

export function mapFieldType(fieldType) {
  switch (fieldType) {
    case 'number':
    case 'decimal':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'picklist':
    case 'dropdown':
      return 'enum';
    // 'countries' is a multi-pick country selector — its stored values are
    // arrays just like 'list', so the dashboard engine must apply
    // any-element (list) semantics to group-by, filters and count-distinct.
    // (Singular 'country' is single-pick and stays text.)
    case 'list':
    case 'countries':
      return 'list';
    default:
      return 'text';
  }
}

export function getSourceDef(sourceId) {
  return DASHBOARD_SOURCES[sourceId] || null;
}
