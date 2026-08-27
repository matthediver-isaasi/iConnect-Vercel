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

function configuredFilter(field) {
  const filter = field?.org_filter;
  if (filter && filter.type && filter.field && Array.isArray(filter.values) && filter.values.length > 0) {
    return filter;
  }
  const statuses = field?.allowed_org_statuses;
  return Array.isArray(statuses) && statuses.length > 0
    ? { type: 'custom', field: 'application_status', values: statuses }
    : null;
}

// Mirrors the public organisations endpoint's saved-field semantics, while
// checking a single organisation without exposing the tenant's organisation list.
export async function isOrganizationEligibleForField({ db, tenantId, organization, field }) {
  const filter = configuredFilter(field);
  if (!filter) return true;

  const values = filter.values
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0 && value.length <= 200);
  if (values.length === 0) return false;

  if (filter.type === 'core') {
    if (!VALID_ORGANIZATION_CORE_FIELDS.includes(filter.field)) return false;
    if (filter.field === 'is_active') return organization.is_active === (values[0] === 'true');
    return values.includes(String(organization[filter.field] ?? ''));
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
  return value !== null && values.map(String).includes(value);
}