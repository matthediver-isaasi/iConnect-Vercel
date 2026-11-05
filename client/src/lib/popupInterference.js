const externalFlowSelector = [
  '[role="dialog"]', '[role="alertdialog"]', '[aria-busy="true"]',
  '[data-popup-critical-flow]', '[data-payment-active]', '[data-booking-active]',
  '[data-testid*="payment"]', '[data-testid*="checkout"]',
  '[data-testid*="event-registration"]', 'iframe[src*="stripe"]',
  'form[data-submitting="true"]', 'form button[type="submit"]:disabled',
].join(",");

export function popupExternalInterferenceActive() {
  return [...document.querySelectorAll(externalFlowSelector)]
    .some((element) => !element.closest("[data-cms-popup-modal]"));
}
