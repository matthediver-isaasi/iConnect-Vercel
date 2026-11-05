const externalFlowSelector = [
  '[role="dialog"]', '[role="alertdialog"]', '[aria-busy="true"]',
  '[data-popup-critical-flow]', '[data-payment-active]', '[data-booking-active]',
  '[data-testid*="payment"]', '[data-testid*="checkout"]',
  '[data-testid*="event-registration"]', 'iframe[src*="stripe"]',
  'form[data-submitting="true"]', 'form button[type="submit"]:disabled',
].join(",");

export function popupExternalInterferenceActive() {
  return [...document.querySelectorAll(externalFlowSelector)]
    .some((element) => {
      if (element.closest("[data-cms-popup-modal]")) return false;
      if (element.matches('iframe[src*="stripe"]')
        && !element.matches('[data-popup-critical-flow], [data-payment-active], [data-booking-active], [aria-busy="true"]')) {
        // Stripe.js mounts a hidden telemetry frame even on non-payment pages.
        // Its presence alone is not an active checkout. Keep visible Elements
        // and 3DS frames, and all explicit payment/booking flow guards.
        for (let node = element; node instanceof Element; node = node.parentElement) {
          const style = window.getComputedStyle(node);
          if (node.hidden || style.display === "none" || ["hidden", "collapse"].includes(style.visibility)) return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      }
      return true;
    });
}
