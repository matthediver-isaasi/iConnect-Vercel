import { supabase } from '../../_lib/database.js';
import { tenantFilter } from './permissions.js';

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
      { name: 'country', label: 'Country', type: 'text' },
      { name: 'created_at', label: 'Created at', type: 'date' },
      { name: 'last_synced', label: 'Last synced', type: 'date' },
      { name: 'training_fund_balance', label: 'Training fund balance', type: 'number', aggregatable: true },
      { name: 'guest_access_period_days', label: 'Guest access period (days)', type: 'number', aggregatable: true },
      { name: 'guest_access_enabled', label: 'Guest access enabled', type: 'boolean' },
      { name: 'guest_access_unlimited', label: 'Guest access unlimited', type: 'boolean' },
      { name: 'purchase_order_enabled', label: 'Purchase order enabled', type: 'boolean' },
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
      { name: 'login_enabled', label: 'Login enabled', type: 'boolean' },
      { name: 'show_in_directory', label: 'Show in directory', type: 'boolean' },
      { name: 'created_on', label: 'Created on', type: 'date' },
      { name: 'last_login', label: 'Last login', type: 'date' },
    ],
  },
};

/**
 * Returns serialisable source descriptors enriched with custom fields for
 * the supplied tenant. Falls back gracefully when preference lookups fail.
 */
export async function getSourceCatalog(tenantId) {
  const sources = [];
  for (const def of Object.values(DASHBOARD_SOURCES)) {
    const customFields = await getCustomFieldsForSource(def, tenantId);
    sources.push({
      id: def.id,
      label: def.label,
      timestampField: def.timestampField,
      systemFields: def.systemFields,
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

function mapFieldType(fieldType) {
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
    case 'list':
      return 'list';
    default:
      return 'text';
  }
}

export function getSourceDef(sourceId) {
  return DASHBOARD_SOURCES[sourceId] || null;
}
