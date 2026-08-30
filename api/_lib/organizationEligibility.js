import { resolveCountryToIso2 } from '../../shared/countries.js';

export const VALID_ORGANIZATION_CORE_FIELDS = [
  'name', 'slug', 'description', 'website_url', 'email', 'invoicing_email', 'phone',
  'address', 'city', 'country', 'postcode', 'external_id', 'is_active',
  'status', 'twitter_url', 'linkedin_url', 'facebook_url', 'instagram_url',
];

export function normalizeOrganizationPreferenceValue(rawValue) {
  return normalizeOrganizationPreferenceValues(rawValue)?.[0] ?? null;
}

export function normalizeOrganizationPreferenceValues(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  let value = rawValue;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return [value]; }
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeOrganizationPreferenceValues(item) || []);
  }
  if (value && typeof value === 'object' && value.value !== undefined) {
    return normalizeOrganizationPreferenceValues(value.value);
  }
  return [String(value)];
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
    if (filter.values.length === 0 && filter.value_source !== 'source') return null;
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

function normalizeComparableFilterValue(value, countryField = false) {
  const normalized = String(value ?? '').trim();
  return countryField ? (resolveCountryToIso2(normalized) || normalized).toLowerCase() : normalized;
}

function coreFilterMatches(organization, filter, values) {
  if (!VALID_ORGANIZATION_CORE_FIELDS.includes(filter.field)) return false;
  if (filter.field === 'is_active') return organization.is_active === (values[0] === 'true');
  const countryField = filter.field === 'country';
  const actual = normalizeComparableFilterValue(organization[filter.field], countryField);
  return values.some((value) => normalizeComparableFilterValue(value, countryField) === actual);
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
        .select('id, field_type')
        .eq('tenant_id', tenantId)
        .eq('name', filter.field)
        .eq('entity_scope', 'organization')
        .eq('is_active', true)
        .maybeSingle();
      if (fieldError) throw fieldError;
      // Preserve the established behavior for stale custom field definitions.
      if (!preferenceField) continue;

      customValues = { fieldType: preferenceField.field_type, values: new Map() };
      const organizationIds = eligible.map((organization) => organization.id).filter(Boolean);
      for (let offset = 0; offset < organizationIds.length; offset += 500) {
        const ids = organizationIds.slice(offset, offset + 500);
        const { data, error } = await db.from('organization_preference_value')
          .select('organization_id, value')
          .eq('field_id', preferenceField.id)
          .in('organization_id', ids);
        if (error) throw error;
        for (const row of data || []) {
          customValues.values.set(String(row.organization_id), normalizeOrganizationPreferenceValues(row.value));
        }
      }
      customValuesByField.set(filter.field, customValues);
    }
    const countryField = ['country', 'countries'].includes(customValues.fieldType);
    const allowed = new Set(values.map((value) => normalizeComparableFilterValue(value, countryField)));
    eligible = eligible.filter((organization) => {
      const organizationValues = customValues.values.get(String(organization.id));
      if (!hasFilterableValue(organizationValues)) return false;
      const matches = organizationValues.some((value) => (
        allowed.has(normalizeComparableFilterValue(value, countryField))
      ));
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
    .select('id, field_type')
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
  const organizationValues = normalizeOrganizationPreferenceValues(preferenceValue?.value);
  if (!hasFilterableValue(organizationValues)) return false;
  const countryField = ['country', 'countries'].includes(preferenceField.field_type);
  const allowed = new Set(values.map(
    (candidate) => normalizeComparableFilterValue(candidate, countryField),
  ));
  const matches = organizationValues.some(
    (value) => allowed.has(normalizeComparableFilterValue(value, countryField)),
  );
  return matchesMode(matches, filter);
}