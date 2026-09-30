// Deliberately project contact fields: never return the complete purchaser
// snapshot (which may gain internal metadata in future).
export function publicInvoicePurchaser(context) {
  if (!context || context.classification !== 'public_non_member') return null;
  const fields = ['first_name', 'last_name', 'email', 'phone', 'job_title', 'organization', 'organization_name', 'organisation_name', 'address', 'address_line_1', 'address_line_2', 'city', 'postcode', 'country'];
  const source = context.details || {};
  return Object.fromEntries(fields.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
}

export function isPublicInvoicePo(booking) {
  return booking.payment_method === 'public_invoice_po'
    && booking.purchaser_context?.classification === 'public_non_member';
}