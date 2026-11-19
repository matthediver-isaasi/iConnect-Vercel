// Checkout-owned answer, not an administrator-selected arbitrary answer key.
export const CHECKOUT_PURCHASE_ORDER_KEY = '__invoice_purchase_order';

export function normalizeCheckoutPurchaseOrder(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('Purchase order number must be text.');
  const normalized = value.trim();
  if (normalized.length > 255) throw new Error('Purchase order number must be no longer than 255 characters.');
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Purchase order number must be a single line of text.');
  return normalized;
}

export function invoicePurchaseOrderReference(checkoutValue, mappedValue) {
  const checkout = normalizeCheckoutPurchaseOrder(checkoutValue);
  const mapped = normalizeCheckoutPurchaseOrder(mappedValue);
  if (checkout && mapped && checkout !== mapped) {
    throw new Error('The checkout purchase order differs from the form purchase order. Use the same number or leave one blank.');
  }
  return checkout || mapped || 'TBC';
}
