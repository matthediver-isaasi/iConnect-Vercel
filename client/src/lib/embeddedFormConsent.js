// Embedded forms do not own the surrounding page's consent interface.
// Do not infer consent from the parent or silently enable tracking in the frame.
// Opening the embed URL directly must still provide normal consent controls.
export function isEmbeddedFormFrame(browser = globalThis.window) {
  if (!browser || !/^\/embed\/form\/[^/]+\/?$/i.test(browser.location.pathname)) return false;
  return browser.self !== browser.top;
}
