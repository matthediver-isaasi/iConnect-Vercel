// Admin-owned settings are read from the saved form, never the cart answer.
import { CHECKOUT_PURCHASE_ORDER_KEY, invoicePurchaseOrderReference } from './formCheckoutPurchaseOrder.js';
export const CART_PO_FIELD_TYPES = ['text', 'short_text'];

export function cartAccountingConfigurationError(cart, fields) {
  for (const key of ['nominal_code', 'project_code']) {
    if (cart[key] != null && (typeof cart[key] !== 'string' || cart[key].length > 100)) {
      return 'Cart accounting codes must be text of up to 100 characters.';
    }
  }
  if (cart.purchase_order_field_id) {
    const source = fields.find(field => field.id === cart.purchase_order_field_id);
    if (!source || !CART_PO_FIELD_TYPES.includes(source.type) || source.parent_field_id) {
      return 'Choose an existing Text field for the cart purchase order.';
    }
  }
  return null;
}

export function cartAccountingSettings(form, answers) {
  const fields = form.fields || [];
  const cart = fields.find(field => field.type === 'sales_cart');
  if (!cart) return null;
  const error = cartAccountingConfigurationError(cart, fields);
  if (error) throw new Error(error);
  const answer = cart.purchase_order_field_id ? answers?.[cart.purchase_order_field_id] : null;
  const reference = invoicePurchaseOrderReference(answers?.[CHECKOUT_PURCHASE_ORDER_KEY], answer);
  return {
    nominalCode: cart.nominal_code?.trim() || null,
    projectCode: cart.project_code?.trim() || null,
    reference,
  };
}
