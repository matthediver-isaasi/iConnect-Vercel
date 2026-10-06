export const ORG_CORE_PUBLICATION_SETTING = 'org_directory_core_publication';
export const ORG_PUBLICATION_FIELDS = Object.freeze([
  { key: 'org_website', column: 'website_url', label: 'Website', field_type: 'website' },
  { key: 'org_phone', column: 'phone', label: 'Phone', field_type: 'phone' },
  { key: 'org_description', column: 'description', label: 'Description', field_type: 'textarea' },
]);

function object(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Ordering and profile permissions are never publication grants.
export function parseOrganisationCorePublication(value) {
  const parsed = object(value);
  return Object.fromEntries(ORG_PUBLICATION_FIELDS.map(({ key }) => [key, parsed[key] === true]));
}

export function resolveOrganisationCorePublication(value, overrides) {
  const publication = parseOrganisationCorePublication(value);
  const parsed = object(overrides);
  for (const { key } of ORG_PUBLICATION_FIELDS) {
    const override = parsed[key];
    if (override && !Array.isArray(override) && typeof override.back === 'boolean') {
      publication[key] = override.back;
    }
  }
  return publication;
}

// Explicit projection: never spread an organisation row into a directory payload.
export function projectOrganisationCoreValues(org, publication, overrides) {
  const enabled = resolveOrganisationCorePublication(publication, overrides);
  return Object.fromEntries(ORG_PUBLICATION_FIELDS.flatMap(({ key, column }) =>
    enabled[key] && typeof org?.[column] === 'string' && org[column].trim()
      ? [[column, org[column].trim()]] : []));
}
