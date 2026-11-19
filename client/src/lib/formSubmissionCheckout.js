import { CHECKOUT_PURCHASE_ORDER_KEY } from '../../../shared/formCheckoutPurchaseOrder.js';
const methods = {
  invoice: 'Pay by invoice',
  stripe: 'Card',
  stripe_monthly_card: 'Monthly card payments',
  gocardless: 'Direct Debit',
};

// Payment fields save their authority on the submission, not in field answers.
export function submissionCheckoutText(field, submission) {
  if (field?.type === 'sales_cart_view') {
    return 'No data is deliberately shown here. This field displays the cart summary during checkout; purchased items are recorded in the cart receipt.';
  }
  if (field?.type !== 'payment') return null;
  const provider = submission?.payment_provider;
  if (!provider) return 'No payment method was recorded.';
  const lines = [`Payment method: ${methods[provider] || provider}`];
  if (submission.payment_status) {
    const status = String(submission.payment_status).replaceAll('_', ' ');
    lines.push(`Payment status: ${status.charAt(0).toUpperCase()}${status.slice(1)}`);
  }
  if (provider === 'invoice') {
    const reference = submission.payment_meta?.invoice_order?.snapshot?.invoice?.args?.reference
      || submission.submission_data?.[CHECKOUT_PURCHASE_ORDER_KEY];
    if (typeof reference === 'string' && reference.trim()) lines.push(`Invoice reference / PO: ${reference.trim()}`);
  }
  return lines.join('\n');
}
