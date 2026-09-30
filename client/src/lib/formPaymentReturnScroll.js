// Keep payment-return scrolling separate from payment confirmation. A return
// is already authorised by the submission/instance-bound relay; this helper
// only positions an already-mounted status surface.

export const PAYMENT_RETURN_READY_MESSAGE = 'iconn-form-payment-return-ready';
export const PAYMENT_RETURN_SCROLL_MARGIN_PX = 16;

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isVisibleFixedHeader(element, documentObj) {
  if (!element) return false;
  if (element.matches?.(
    '[data-payment-return-fixed-header], [data-canvas-sticky], header.sticky, header[class*="sticky"], header.fixed, header[class*="fixed"], nav.sticky, nav[class*="sticky"], nav.fixed, nav[class*="fixed"]',
  )) {
    return true;
  }

  const view = documentObj?.defaultView;
  const style = view?.getComputedStyle ? view.getComputedStyle(element) : null;
  return style?.position === 'fixed' || style?.position === 'sticky';
}

/**
 * Find the visible public chrome that can cover a return surface. The
 * `header.sticky` selector mirrors the existing public anchor-scroll behaviour,
 * while the data attribute lets a host page opt in without changing classes.
 */
export function getPaymentReturnHeaderOffset(
  documentObj = typeof document !== 'undefined' ? document : null,
) {
  if (!documentObj?.querySelectorAll) return 0;

  const candidates = documentObj.querySelectorAll(
    'header, nav, [data-canvas-sticky], [data-payment-return-fixed-header]',
  );
  let offset = 0;
  for (const element of candidates) {
    if (!isVisibleFixedHeader(element, documentObj)) continue;
    const rect = element.getBoundingClientRect?.();
    const top = asNumber(rect?.top, 0);
    const bottom = asNumber(rect?.bottom, 0);
    const height = asNumber(element.offsetHeight, 0);
    const viewportHeight = asNumber(documentObj.defaultView?.innerHeight, Infinity);
    // A sticky header in normal flow below the viewport must not affect the
    // target. Fixed headers normally have a top of zero and remain eligible.
    if (bottom > 0 && top < viewportHeight && height > 0) offset = Math.max(offset, bottom);
  }
  return offset;
}

/**
 * Scroll a payment-return target into the visible area without moving an
 * already-visible target. Returns true when a window scroll was requested.
 */
export function scrollPaymentReturnTarget(
  target,
  {
    windowObj = typeof window !== 'undefined' ? window : null,
    documentObj = typeof document !== 'undefined' ? document : null,
    margin = PAYMENT_RETURN_SCROLL_MARGIN_PX,
    behavior = 'auto',
  } = {},
) {
  if (!target || !windowObj?.scrollTo) return false;

  const rect = target.getBoundingClientRect?.();
  if (!rect) return false;

  const headerOffset = getPaymentReturnHeaderOffset(documentObj);
  const topBoundary = headerOffset + margin;
  const viewportHeight = asNumber(windowObj.innerHeight, 0);
  const bottomBoundary = viewportHeight > 0 ? viewportHeight - margin : Infinity;
  const top = asNumber(rect.top, 0);
  const bottom = asNumber(rect.bottom, top + asNumber(rect.height, 0));

  if (top >= topBoundary && bottom <= bottomBoundary) return false;

  const pageYOffset = asNumber(
    windowObj.pageYOffset ?? windowObj.scrollY,
    0,
  );
  const documentHeight = asNumber(
    documentObj?.documentElement?.scrollHeight
      || documentObj?.body?.scrollHeight,
    0,
  );
  const maxScroll = viewportHeight > 0 && documentHeight > 0
    ? Math.max(0, documentHeight - viewportHeight)
    : Infinity;
  const destination = Math.max(
    0,
    Math.min(top + pageYOffset - headerOffset - margin, maxScroll),
  );

  windowObj.scrollTo({ top: destination, behavior });
  return true;
}

/**
 * Defer one return scroll until the target and any immediate iframe layout
 * work have been committed. The callback is deliberately bounded and returns
 * cleanup so StrictMode probes cannot leave a delayed scroll behind.
 */
export function schedulePaymentReturnScroll(
  target,
  {
    windowObj = typeof window !== 'undefined' ? window : null,
    documentObj = typeof document !== 'undefined' ? document : null,
    delay = 0,
    onSettled,
  } = {},
) {
  let cancelled = false;
  let frameId = null;
  let timerId = null;
  const requestFrame = windowObj?.requestAnimationFrame
    ? (callback) => windowObj.requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 0);
  const cancelFrame = windowObj?.cancelAnimationFrame
    ? (id) => windowObj.cancelAnimationFrame(id)
    : (id) => clearTimeout(id);

  frameId = requestFrame(() => {
    if (cancelled) return;
    timerId = setTimeout(() => {
      if (cancelled) return;
      const didScroll = scrollPaymentReturnTarget(target, {
        windowObj,
        documentObj,
      });
      onSettled?.({ didScroll });
    }, Math.max(0, delay));
  });

  return () => {
    cancelled = true;
    if (frameId != null) cancelFrame(frameId);
    if (timerId != null) clearTimeout(timerId);
  };
}