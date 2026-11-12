export { cartConfigurationError, formatCartReceipt } from '../../../shared/formCart.js';

export const CART_UNAVAILABLE_EVENT = 'form-cart-unavailable';
export const CART_LOCKED_EVENT = 'form-cart-locked';
export const CART_UNLOCKED_EVENT = 'form-cart-unlocked';

export function cartPriceSource(form) {
  const payment = form?.fields?.find(field => field.type === 'payment');
  return form?.fields?.find(field => field.type === 'sales_cart' && field.id === payment?.price_field_id) || null;
}

export function notifyCartUnavailable(formId, error) {
  const data = error?.errorData || error;
  if (data?.code !== 'CART_UNAVAILABLE') return false;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CART_UNAVAILABLE_EVENT, {
    detail: { formId, fieldId: data.field_id || null },
  }));
  return true;
}

export function lockFormCart(formId, provider = null) {
  if (formId && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CART_LOCKED_EVENT, { detail: { formId, provider } }));
}

// Only call after the server has ended the previous attempt and the caller
// has successfully rotated its idempotency key.
export function unlockFormCart(formId) {
  if (formId && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CART_UNLOCKED_EVENT, { detail: { formId } }));
}

export const catalogueRows = data => Array.isArray(data) ? data : data?.items || data?.results || [];
export const eligibleCartProduct = product => !!product && !product.eventReference && !product.spaceRequirementId;
