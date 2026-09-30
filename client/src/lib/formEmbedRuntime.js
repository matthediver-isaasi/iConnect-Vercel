// Resize reports remain compatible with existing embed scripts. Navigation is a
// separate signal: a height change alone must never move the containing page.
export const FORM_PAGE_NAVIGATED_MESSAGE = 'iconn-form-page-navigated';
export const FORM_SUCCESS_READY_MESSAGE = 'iconn-form-success-ready';

// Drop-in is a body-level, fixed, 100%-height iframe, outside our flow-root.
// Its rectangle (and this window's innerHeight) just echoes the height assigned
// by the host. Reserve a usable viewport independently of either value. Narrow
// layouts need extra vertical room for wrapped bank/receipt content; the
// provider's own scrolling is deliberately left untouched.
export function formEmbedPaymentViewportHeight(width) {
  return width < 600 ? 820 : 720;
}

export function measureFormContent(root) {
  // This flow-root wraps every runtime state and has no viewport-sized minimum.
  // documentElement.scrollHeight cannot shrink below the assigned iframe height.
  return Math.ceil(Math.max(root.getBoundingClientRect().height, root.scrollHeight));
}

export function observeFormEmbedContent(root, windowObj = window) {
  let frame = null;
  let disposed = false;
  let lastHeight = null;
  let navigationPending = false;
  let completionPending = null;
  let paymentNaturalHeight = 0;
  let activePayment = null;
  const body = root.ownerDocument?.body;
  const paymentOverlay = () => windowObj.parent !== windowObj
    ? body?.querySelector(':scope > iframe[id^="gocardless-dropin-iframe-"]')
    : null;
  const report = () => {
    frame = null;
    if (disposed) return;
    const naturalHeight = measureFormContent(root);
    const payment = paymentOverlay();
    // Preserve the natural-content high water mark only for this overlay's
    // lifetime. A confirmation render must not shrink a still-visible receipt.
    // Never feed a reported/assigned viewport height back into this value.
    paymentNaturalHeight = payment
      ? Math.max(payment === activePayment ? paymentNaturalHeight : 0, naturalHeight)
      : 0;
    activePayment = payment;
    const height = payment
      ? Math.max(paymentNaturalHeight, formEmbedPaymentViewportHeight(windowObj.innerWidth))
      : naturalHeight;
    // A completed surface must publish its final intrinsic height before its
    // ready signal. While GoCardless still owns a body-level iframe, keep the
    // completion pending: that overlay's removal is the authoritative point
    // at which the compact receipt has actually been revealed.
    const completionReady = completionPending && !payment;
    if (height > 0 && (height !== lastHeight || navigationPending || completionReady)) {
      windowObj.parent.postMessage({ type: 'iconn-form-resize', height }, '*');
      lastHeight = height;
    }
    if (navigationPending) {
      navigationPending = false;
      if (windowObj.parent !== windowObj) {
        // Canvas embeds are same-origin. External copied scripts retain resize
        // compatibility, but cannot opt into navigation of an unrelated host.
        windowObj.parent.postMessage(
          { type: FORM_PAGE_NAVIGATED_MESSAGE, height },
          windowObj.location.origin,
        );
      } else {
        windowObj.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
    if (completionReady) {
      const messageType = completionPending;
      completionPending = null;
      if (windowObj.parent !== windowObj) {
        windowObj.parent.postMessage(
          { type: messageType, height },
          windowObj.location.origin,
        );
      }
    }
  };
  const schedule = () => {
    if (disposed || frame != null) return;
    frame = windowObj.requestAnimationFrame(report);
  };
  const observer = new windowObj.ResizeObserver(schedule);
  observer.observe(root);
  // Vendor open/return/exit mutate body children, not the natural form wrapper.
  // Observe only our own document: sibling embeds cannot reserve our height.
  const overlays = body ? new windowObj.MutationObserver(schedule) : null;
  overlays?.observe(body, { childList: true });
  windowObj.addEventListener('resize', schedule);
  schedule();
  return {
    schedule,
    navigated() {
      navigationPending = true;
      schedule();
    },
    completed(messageType = FORM_SUCCESS_READY_MESSAGE) {
      // Coalesce repeated success effects while retaining the first surface
      // classification. Callers use the payment-return type for a terminal
      // hosted return and the default type for an inline/form success.
      if (!completionPending) completionPending = messageType;
      schedule();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      overlays?.disconnect();
      windowObj.removeEventListener('resize', schedule);
      if (frame != null) windowObj.cancelAnimationFrame(frame);
    },
  };
}

export function isFormEmbedMessage(event, iframe, expectedUrl, windowObj = window) {
  if (!iframe || event.source !== iframe.contentWindow) return false;
  try {
    return event.origin === new URL(expectedUrl, windowObj.location.href).origin;
  } catch {
    return false;
  }
}

export function scrollFormPageTarget(target, windowObj = window) {
  let headerBottom = 0;
  const doc = target.ownerDocument;
  for (const header of doc.querySelectorAll('header, nav, [data-canvas-sticky]')) {
    const style = windowObj.getComputedStyle(header);
    const rect = header.getBoundingClientRect();
    if ((style.position === 'sticky' || style.position === 'fixed')
      && rect.bottom > 0 && rect.top < windowObj.innerHeight) {
      headerBottom = Math.max(headerBottom, rect.bottom);
    }
  }
  // An immediate, post-layout scroll avoids a smooth animation racing a later
  // resize or browser scroll anchoring during a tall-to-short transition.
  windowObj.scrollTo({
    top: Math.max(0, windowObj.scrollY + target.getBoundingClientRect().top - headerBottom - 16),
    behavior: 'auto',
  });
}