export const VALID_ORGANIZATION_CORE_FIELDS = [
  'name', 'slug', 'description', 'website_url', 'email', 'invoicing_email', 'phone',
  'address', 'city', 'country', 'postcode', 'external_id', 'is_active',
  'status', 'twitter_url', 'linkedin_url', 'facebook_url', 'instagram_url',
];

export function normalizeOrganizationPreferenceValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  let value = rawValue;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return value; }
  }
  if (value && typeof value === 'object') {
    if (value.value !== undefined) return String(value.value);
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      return typeof first === 'object' && first.value !== undefined ? String(first.value) : String(first);
    }
  }
  return String(value);
}

const INVALID_FILTER = Symbol('invalid-organization-filter');

function configuredFilter(field) {
  const filter = field?.org_filter;
  if (filter !== undefined && filter !== null) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)
        || !['core', 'custom'].includes(filter.type)
        || typeof filter.field !== 'string' || !filter.field
        || !Array.isArray(filter.values)
        || !validFilterMode(filter)) {
      return INVALID_FILTER;
    }
    // Legacy include filters with no selected values have always meant no
    // restriction. Empty exclude filters intentionally mean the same thing.
    if (filter.values.length === 0) return null;
    return filter;
  }
  const statuses = field?.allowed_org_statuses;
  return Array.isArray(statuses) && statuses.length > 0
    ? { type: 'custom', field: 'application_status', values: statuses }
    : null;
}

function matchesMode(matches, filter) {
  return filter?.mode === 'exclude' ? !matches : matches;
}

function hasFilterableValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasFilterableValue);
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function validFilterMode(filter) {
  return filter?.mode === undefined || filter.mode === 'include' || filter.mode === 'exclude';
}

function sanitizedFilterValues(filter) {
  return filter.values
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0 && value.length <= 200);
}

function coreFilterMatches(organization, filter, values) {
  if (!VALID_ORGANIZATION_CORE_FIELDS.includes(filter.field)) return false;
  if (filter.field === 'is_active') return organization.is_active === (values[0] === 'true');
  return values.includes(String(organization[filter.field] ?? ''));
}

export async function filterOrganizationsEligibleForFields({
  db, tenantId, organizations, fields = [],
}) {
  let eligible = Array.isArray(organizations) ? organizations : [];
  const customValuesByField = new Map();

  for (const field of fields) {
    const filter = configuredFilter(field);
    if (filter === INVALID_FILTER) return [];
    if (!filter) continue;
    if (!validFilterMode(filter)) return [];
    const values = sanitizedFilterValues(filter);
    if (values.length === 0) return [];

    if (filter.type === 'core') {
      eligible = eligible.filter((organization) => {
        if (!hasFilterableValue(organization?.[filter.field])) return false;
        return matchesMode(coreFilterMatches(organization, filter, values), filter);
      });
      continue;
    }
    if (filter.type !== 'custom') return [];

    let customValues = customValuesByField.get(filter.field);
    if (!customValues) {
      const { data: preferenceField, error: fieldError } = await db.from('preference_field')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('name', filter.field)
        .eq('entity_scope', 'organization')
        .eq('is_active', true)
        .maybeSingle();
      if (fieldError) throw fieldError;
      // Preserve the established behavior for stale custom field definitions.
      if (!preferenceField) continue;

      customValues = new Map();
      const organizationIds = eligible.map((organization) => organization.id).filter(Boolean);
      for (let offset = 0; offset < organizationIds.length; offset += 500) {
        const ids = organizationIds.slice(offset, offset + 500);
        const { data, error } = await db.from('organization_preference_value')
          .select('organization_id, value')
          .eq('field_id', preferenceField.id)
          .in('organization_id', ids);
        if (error) throw error;
        for (const row of data || []) {
          customValues.set(String(row.organization_id), normalizeOrganizationPreferenceValue(row.value));
        }
      }
      customValuesByField.set(filter.field, customValues);
    }
    const allowed = new Set(values);
    eligible = eligible.filter((organization) => {
      const value = customValues.get(String(organization.id));
      if (!hasFilterableValue(value)) return false;
      const matches = allowed.has(value);
      return matchesMode(matches, filter);
    });
  }

  return eligible;
}

// Mirrors the public organisations endpoint's saved-field semantics, while
// checking a single organisation without exposing the tenant's organisation list.
export async function isOrganizationEligibleForField({ db, tenantId, organization, field }) {
  const filter = configuredFilter(field);
  if (filter === INVALID_FILTER) return false;
  if (!filter) return true;
  if (!validFilterMode(filter)) return false;

  const values = sanitizedFilterValues(filter);
  if (values.length === 0) return false;

  if (filter.type === 'core') {
    if (!hasFilterableValue(organization?.[filter.field])) return false;
    return matchesMode(coreFilterMatches(organization, filter, values), filter);
  }
  if (filter.type !== 'custom') return false;

  const { data: preferenceField, error: fieldError } = await db.from('preference_field')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', filter.field)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .maybeSingle();
  if (fieldError) throw fieldError;
  // This preserves the endpoint's established behaviour: a stale custom
  // filter field does not hide every organisation.
  if (!preferenceField) return true;

  const { data: preferenceValue, error: valueError } = await db.from('organization_preference_value')
    .select('value')
    .eq('organization_id', organization.id)
    .eq('field_id', preferenceField.id)
    .maybeSingle();
  if (valueError) throw valueError;
  const value = normalizeOrganizationPreferenceValue(preferenceValue?.value);
  if (!hasFilterableValue(value)) return false;
  const matches = values.map(String).includes(value);
  return matchesMode(matches, filter);
}