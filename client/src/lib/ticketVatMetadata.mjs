// An editor round trip must not select a new tax treatment. In particular,
// zero, explicit null, exempt codes and omitted legacy fields are distinct.
export function preserveTicketVatMetadata(ticket, includeInvoicePolicy = false) {
  const keys = ['vat_rate_key', 'vat_rate_label', 'vat_rate_percentage'];
  // Simple tickets store this in pricing JSON. Complex ticket rows do not
  // have an invoice_line_amount_type column.
  if (includeInvoicePolicy) keys.push('invoice_line_amount_type');
  return Object.fromEntries(
    keys.filter(key => Object.prototype.hasOwnProperty.call(ticket, key))
      .map(key => [key, ticket[key]]),
  );
}