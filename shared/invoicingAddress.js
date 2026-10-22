// Independent billing addresses: never inherit between members, organisations
// and groups. Country is a human-readable name, not an ISO code.
export const INVOICING_ADDRESS_FIELDS = Object.freeze([
  { key: 'invoicing_address_line1', label: 'Invoicing address line 1', maxLength: 255 },
  { key: 'invoicing_address_line2', label: 'Invoicing address line 2', maxLength: 255 },
  { key: 'invoicing_city', label: 'Invoicing city / town', maxLength: 100 },
  { key: 'invoicing_region', label: 'Invoicing county / state / region', maxLength: 100 },
  { key: 'invoicing_postal_code', label: 'Invoicing postcode / ZIP', maxLength: 32 },
  { key: 'invoicing_country', label: 'Invoicing country', maxLength: 50 },
].map(Object.freeze));

export const INVOICING_ADDRESS_KEYS = Object.freeze(INVOICING_ADDRESS_FIELDS.map(field => field.key));

// Returns an explicit validation error; never stringify arbitrary form objects.
export function invoicingAddressError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  for (const { key, label, maxLength } of INVOICING_ADDRESS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const value = payload[key];
    if (value === null) continue;
    if (typeof value !== 'string') return `${label} must be text or null`;
    if (value.length > maxLength) return `${label} must be at most ${maxLength} characters`;
    if (/[\u0000-\u001f\u007f]/u.test(value)) return `${label} must be a single line of text`;
  }
  return null;
}

/**
 * Pure, opt-in resolution for a NEW invoice's explicitly selected owner only.
 * Structured addresses require a nonblank first line to be usable. Incomplete
 * structured entries fall back to organization legacy text, or return null.
 * Never splice structured and legacy components.
 * Existing financial/recovery paths intentionally do not call this helper.
 */
export function resolveStoredInvoicingAddress(record, entityType) {
  if (!['member', 'organization', 'organization_group'].includes(entityType)) {
    throw new TypeError('Unsupported invoicing address entity');
  }
  const error = invoicingAddressError(record);
  if (error) throw new TypeError(error);
  const values = INVOICING_ADDRESS_KEYS.map(key => typeof record?.[key] === 'string' ? record[key].trim() : '');
  if (values[0]) {
    return {
      source: 'structured',
      address: Object.fromEntries(INVOICING_ADDRESS_KEYS.map((key, index) => [key, values[index]])),
    };
  }
  const legacy = entityType === 'organization' && typeof record?.invoicing_address === 'string'
    ? record.invoicing_address : null;
  return legacy?.trim() ? { source: 'legacy', address: legacy } : null;
}

// These mappers perform no provider calls, contact upserts or identity selection.
// Legacy text is deliberately not parsed into guessed city/postcode components.
export function invoicingAddressToXero(resolved) {
  if (!resolved) return null;
  if (resolved.source === 'legacy') return { AddressType: 'POBOX', AddressLine1: resolved.address };
  const a = resolved.address;
  return {
    AddressType: 'POBOX', AddressLine1: a.invoicing_address_line1,
    AddressLine2: a.invoicing_address_line2, City: a.invoicing_city,
    Region: a.invoicing_region, PostalCode: a.invoicing_postal_code, Country: a.invoicing_country,
  };
}

export function invoicingAddressToQuickBooks(resolved) {
  if (!resolved) return null;
  if (resolved.source === 'legacy') return { Line1: resolved.address };
  const a = resolved.address;
  return {
    Line1: a.invoicing_address_line1, Line2: a.invoicing_address_line2,
    City: a.invoicing_city, CountrySubDivisionCode: a.invoicing_region,
    PostalCode: a.invoicing_postal_code, Country: a.invoicing_country,
  };
}

export function redactInvoicingAddress(record) {
  if (!record || typeof record !== 'object') return record;
  const safe = { ...record };
  for (const key of INVOICING_ADDRESS_KEYS) delete safe[key];
  return safe;
}
