// Resize reports remain compatible with existing embed scripts. Navigation is a
// separate signal: a height change alone must never move the containing page.
export const FORM_PAGE_NAVIGATED_MESSAGE = 'iconn-form-page-navigated';

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
  const report = () => {
    frame = null;
    if (disposed) return;
    const height = measureFormContent(root);
    if (height > 0 && (height !== lastHeight || navigationPending)) {
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
  };
  const schedule = () => {
    if (disposed || frame != null) return;
    frame = windowObj.requestAnimationFrame(report);
  };
  const observer = new windowObj.ResizeObserver(schedule);
  observer.observe(root);
  schedule();
  return {
    schedule,
    navigated() {
      navigationPending = true;
      schedule();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
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