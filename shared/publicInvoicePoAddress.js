import { INVOICING_ADDRESS_KEYS, invoicingAddressError, resolveStoredInvoicingAddress } from './invoicingAddress.js';

export function normalizePublicInvoicePoAddress(info = {}) {
  return Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [
    key, typeof info?.[key] === 'string' ? info[key].trim() : '',
  ]));
}

export function publicInvoicePoAddressError(info = {}, { required = true } = {}) {
  const error = invoicingAddressError(info);
  if (error) return error;
  if (!required) return null;
  if (typeof info.organization !== 'string' || !info.organization.trim()) return 'Organisation name is required for the invoice.';
  const address = normalizePublicInvoicePoAddress(info);
  for (const [key, label] of [
    ['invoicing_address_line1', 'Invoice address line 1'],
    ['invoicing_city', 'Invoice city / town'],
    ['invoicing_postal_code', 'Invoice postcode / ZIP'],
    ['invoicing_country', 'Invoice country'],
  ]) if (!address[key]) return `${label} is required.`;
  return null;
}

// Billing belongs to the captured purchaser, never an attendee's current profile.
// Booker corrections change delivery identity, not historical billing evidence.
export function publicInvoicePoBillingContact(original, booker, memberId) {
  const organization = typeof original?.organization === 'string' ? original.organization.trim() : '';
  const invoicingAddress = resolveStoredInvoicingAddress(original || {}, 'organization');
  return {
    name: organization || [booker?.first_name, booker?.last_name].filter(Boolean).join(' '),
    email: booker?.email,
    isOrganization: Boolean(organization),
    ...(invoicingAddress ? { invoicingAddress } : {}),
    // The approval RPC binds billing authority to the verified booker account.
    // This is not the account's current billing name or address.
    provenance: { kind: 'member', id: memberId },
  };
}
