export function requestFormCartActivity(formId) {
  if (!formId) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const detail = { formId, resolve, reject, handled: false };
    window.dispatchEvent(new CustomEvent('form-cart-activity', { detail }));
    if (!detail.handled) reject(new Error('Please return to your cart before continuing payment.'));
  });
}
