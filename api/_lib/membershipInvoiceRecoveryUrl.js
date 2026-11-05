import { getTenantTrustedBaseUrl } from './publicBaseUrl.js';

// Keep the purchase-order reference exclusively for the customer's PO.
// Xero's source URL carries the durable recovery identity instead.
export async function membershipInvoiceRecoveryUrl(db, tenantId) {
  const { data, error } = await db.from('tenant').select('slug,domain').eq('id', tenantId).maybeSingle();
  if (error || !data?.slug) throw new Error('Invoice source link could not be resolved for this tenant.');
  return `${getTenantTrustedBaseUrl(null, data)}/portal`;
}
