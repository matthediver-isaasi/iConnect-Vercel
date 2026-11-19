import { INVOICING_ADDRESS_FIELDS, invoicingAddressError } from './invoicingAddress.js';

export const REQUIRED_INVOICE_ADDRESS_KEYS = ['invoicing_address_line1', 'invoicing_city', 'invoicing_postal_code', 'invoicing_country'];
export const invoiceAddressFieldTypes = key => key === 'invoicing_country' ? ['text', 'short_text', 'country'] : ['text', 'short_text'];
export function invoiceBillingConfigurationError(field, fields = []) {
  if (!field.payment_providers?.includes('invoice')) return null;
  if (field.invoice_billing_source && !['organization', 'fields'].includes(field.invoice_billing_source)) return 'Choose a valid invoice details source.';
  const exists = (id, types) => fields.some(f => f.id === id && types.includes(f.type));
  if (field.invoice_billing_source === 'organization') {
    return exists(field.invoice_organization_field_id, ['organisation_dropdown']) ? null
      : 'Pay by invoice needs an Organisation Drop Down.';
  }
  if (!exists(field.invoice_billing_name_field_id, ['text', 'short_text', 'full_name', 'organisation_dropdown'])) return 'Pay by invoice needs a Billing name field (Text or Organisation Drop Down).';
  if (!exists(field.invoice_billing_email_field_id, ['email'])) return 'Pay by invoice needs a Billing email field (Email).';
  for (const { key, label } of INVOICING_ADDRESS_FIELDS) {
    const id = field.invoice_address_fields?.[key];
    if ((id || (field.invoice_billing_source === 'fields' && REQUIRED_INVOICE_ADDRESS_KEYS.includes(key)))
      && !exists(id, invoiceAddressFieldTypes(key))) return `Choose a form field for ${label.toLowerCase()}.`;
  }
  return null;
}

export function structuredInvoiceAddress(record) {
  const values = Object.fromEntries(INVOICING_ADDRESS_FIELDS.map(({ key }) => [key, record?.[key] ?? '']));
  const error = invoicingAddressError(values);
  if (error) throw new Error(error);
  for (const key of Object.keys(values)) values[key] = String(values[key] ?? '').trim();
  for (const key of REQUIRED_INVOICE_ADDRESS_KEYS) {
    if (!values[key]) throw new Error(`${INVOICING_ADDRESS_FIELDS.find(f => f.key === key).label} is required.`);
  }
  return { source: 'structured', address: values };
}

export function mappedInvoiceAddress(field, fields, values) {
  const record = {};
  for (const { key } of INVOICING_ADDRESS_FIELDS) {
    const id = field.invoice_address_fields?.[key];
    if (!id) continue;
    if (!fields.some(f => f.id === id && invoiceAddressFieldTypes(key).includes(f.type))) throw new Error('Invoice address mapping is unavailable.');
    record[key] = values[id] ?? '';
  }
  return structuredInvoiceAddress(record);
}
