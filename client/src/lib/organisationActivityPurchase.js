import { formSubmissionInvoice } from '../../../shared/formSubmissionInvoice.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const statusLabel = value => text(value).replaceAll('_', ' ');

// Use recorded purchase evidence only, never today's catalogue or invoice total
// as evidence of settlement. The caller must have submission-management access.
export function organisationActivityPurchase(submission, { canView, tenantId, organizationId }) {
  if (!canView || !tenantId || !organizationId
    || submission?.tenant_id !== tenantId || submission?.organization_id !== organizationId
    || submission.payment_provider !== 'invoice') return null;

  const meta = submission.payment_meta || {};
  const order = meta.invoice_order;
  const receipt = submission.submission_data?.__cart_receipt;
  const lines = order?.version === 1 && Array.isArray(order.snapshot?.lines)
    ? order.snapshot.lines
    : receipt?.version === 1 && Array.isArray(receipt.lines) ? receipt.lines : [];
  const items = lines.flatMap(line => {
    const name = text(line?.name) || text(line?.description);
    if (!name) return [];
    const quantity = typeof line.quantity === 'number' && Number.isFinite(line.quantity) ? line.quantity : null;
    return [quantity === null ? name : `${quantity} × ${name}`];
  });
  const amount = submission.payment_amount;
  const currency = text(submission.payment_currency).toUpperCase();
  const validAmount = (typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== ''))
    && Number.isFinite(Number(amount));
  const invoice = formSubmissionInvoice(submission);
  return {
    items,
    amount: validAmount ? `${currency ? `${currency} ` : ''}${Number(amount).toFixed(2)}${currency ? '' : ' (currency not recorded)'}` : null,
    invoice: invoice.number ? `Invoice ${invoice.number}`
      : invoice.linked ? 'Invoice issued (number not recorded)' : 'Invoice requested — accounting processing pending',
    invoiceStatus: statusLabel(meta.invoice_result?.status),
    paymentStatus: statusLabel(submission.payment_status) || 'not recorded',
  };
}
