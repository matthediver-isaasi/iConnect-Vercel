import { popupDiagnostic } from './popupDiagnostics.js';

const criticalSelector = [
  '[role="dialog"]', '[role="alertdialog"]',
  '[data-popup-critical-flow]', '[data-payment-active]', '[data-booking-active]',
  '[data-testid*="payment"]', '[data-testid*="checkout"]',
  '[data-testid*="event-registration"]', 'iframe[src*="stripe"]',
  'form[data-submitting="true"]', 'form button[type="submit"]:disabled',
].join(",");
const externalFlowSelector = `${criticalSelector},[aria-busy="true"]`;
const backgroundKinds = new Set(["content_list", "group_list", "photo_grid"]);
let lastBlocker = null;

function reportBlocker(element) {
  const reason = !element ? null
    : element.matches('[role="dialog"],[role="alertdialog"]') ? "dialog"
      : element.matches('[data-testid="loading-home-page"]') ? "homepage_loading"
        : element.matches('[data-membership-card]') ? "membership_loading"
          : element.matches('[data-popup-loading="embedded_form"]') ? "embedded_form_loading"
            : element.matches('[aria-busy="true"]') ? "unclassified_busy" : "critical_flow";
  if (reason !== lastBlocker) popupDiagnostic("interference_changed", { reason: reason || "clear" });
  lastBlocker = reason;
}

export function popupExternalInterferenceReason() {
  const blocking = [...document.querySelectorAll(externalFlowSelector)]
    .find((element) => {
      if (element.closest("[data-cms-popup-modal]")) return false;
      // Only explicitly reviewed read-only content loaders are exempt. Keep
      // aria-busy for accessibility, and never exempt dialogs or critical flows.
      if (element.matches('[aria-busy="true"]')
        && backgroundKinds.has(element.getAttribute("data-popup-background-loading"))
        && !element.closest(criticalSelector)) return false;
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
  reportBlocker(blocking);
  if (!blocking) return null;
  if (blocking.matches('[role="dialog"],[role="alertdialog"]')) return "other_dialog";
  if (blocking.matches('[aria-busy="true"]')) return "page_busy";
  if (blocking.matches('iframe[src*="stripe"]')) return "payment_frame";
  if (blocking.matches('[data-payment-active],[data-testid*="payment"],[data-testid*="checkout"]')) return "payment_flow";
  if (blocking.matches('[data-booking-active],[data-testid*="event-registration"]')) return "booking_flow";
  if (blocking.matches('form[data-submitting="true"],form button[type="submit"]:disabled')) return "form_submitting";
  return "critical_flow";
}

export const popupExternalInterferenceActive = () => !!popupExternalInterferenceReason();
