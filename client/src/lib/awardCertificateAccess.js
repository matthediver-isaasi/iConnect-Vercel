// Eagerly loaded before App: fragments must leave the address bar before any
// application effects or authenticated requests run. Never persist the token.
let access = null;
let serial = 0;
export function captureAwardCertificateAccess() {
  if (typeof window === 'undefined' || !/^\/award-certificate\/?$/i.test(window.location.pathname)) return null;
  const context = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  if (window.location.hash) {
    const hash = window.location.hash.slice(1);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    let token = null;
    try {
      token = hash.startsWith('token=') ? new URLSearchParams(hash).get('token') : decodeURIComponent(hash);
      if (!token || token.length > 4096 || /[\r\n\0]/.test(token)) token = null;
    } catch { /* Report an invalid link without retaining or echoing its fragment. */ }
    access = { context, token, invalid: !token, serial: ++serial };
  }
  return access?.context === context ? access : { context, token: null, invalid: false };
}
export function clearAwardCertificateAccess() { access = null; }
captureAwardCertificateAccess();
