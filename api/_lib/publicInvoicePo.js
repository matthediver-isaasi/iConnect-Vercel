export const PUBLIC_INVOICE_PO = 'public_invoice_po';

// This records an intention only. It is not an invoice, receivable or payment.
export async function validatePublicInvoicePo({
  client, event, authenticatedMember, purchaserInfo, stripePaymentIntentId,
  voucherIds, trainingFundAmount, accountAmount, allocationContext, purchaseOrderNumber,
}) {
  if (event?.allow_public_invoice_po !== true || event.member_group_id) {
    throw new Error('Public Invoice / PO is not enabled for this event');
  }
  if (authenticatedMember || allocationContext) {
    throw new Error('Invoice / PO is only available to public non-member purchasers');
  }
  if (stripePaymentIntentId || voucherIds?.length
      || (trainingFundAmount != null && Number(trainingFundAmount) !== 0)
      || (accountAmount != null && Number(accountAmount) !== 0)) {
    throw new Error('Invoice / PO cannot be combined with online payment, vouchers or account funds');
  }
  if (!purchaserInfo || typeof purchaserInfo !== 'object' || Array.isArray(purchaserInfo)) {
    throw new Error('Purchaser contact details are required');
  }
  // Snapshot only contact fields collected by checkout, never arbitrary caller
  // metadata (which could contain access tokens or internal workflow flags).
  const details = {};
  for (const field of ['email', 'first_name', 'last_name', 'organization', 'phone', 'job_title']) {
    const value = purchaserInfo[field];
    if (value == null) continue;
    if (typeof value !== 'string' || value.length > 2048) {
      throw new Error(`Invalid purchaser ${field.replaceAll('_', ' ')}`);
    }
    details[field] = value.trim();
  }
  for (const field of ['email', 'first_name', 'last_name']) {
    if (typeof details[field] !== 'string' || !details[field].trim()) {
      throw new Error(`Purchaser ${field.replaceAll('_', ' ')} is required`);
    }
    details[field] = details[field].trim();
  }
  details.email = details.email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
    throw new Error('A valid purchaser email is required');
  }
  // Eligibility is exclusively about the purchaser, never an attendee.
  const { data, error } = await client.from('member').select('id')
    .eq('tenant_id', event.tenant_id).ilike('email', details.email.replace(/[\\%_]/g, '\\$&')).limit(1);
  if (error) throw new Error('Unable to verify purchaser eligibility');
  if (data?.length) throw new Error('Members must sign in and use the member payment options');
  if (purchaseOrderNumber != null && (typeof purchaseOrderNumber !== 'string' || purchaseOrderNumber.length > 255)) {
    throw new Error('Purchase Order Number must be text of at most 255 characters');
  }
  return {
    classification: 'public_non_member',
    submitted_at: new Date().toISOString(),
    details,
  };
}

export function requirePublicInvoicePoBalance(amount) {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new Error('Invoice / PO requires a paid ticket; use free registration for a zero balance');
  }
}