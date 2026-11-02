import { bootstrapGoogleConsentMode } from '@cookieyes/scripts';
bootstrapGoogleConsentMode();
let property = null, lastPage = null, allowed = false;
export function clearTrackingStorage() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('iconn:event-click-visitor:')) localStorage.removeItem(key);
  } catch {}
  for (const entry of document.cookie.split(';')) {
    const name = entry.split('=')[0].trim();
    if (!/^(_ga(?:_|$)|_gid$|_gat(?:_|$))/.test(name)) continue;
    const labels = location.hostname.split('.');
    for (let i=0;i<labels.length-1;i++) {
      document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${labels.slice(i).join('.')}`;
    }
    document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}
export function disableTracking(id) {
  allowed = false;
  if (id) property=id;
  if (property) window[`ga-disable-${property}`] = true;
  clearTrackingStorage();
  // Removing a script cannot remove Google's event listeners.
  if (property) setTimeout(()=>location.reload(),0);
}
export function trackConsentPage() {
  const path = location.pathname + location.search;
  if (!allowed || !property || /^\/(?:admin|platform)/i.test(path) || lastPage === path) return;
  lastPage = path;
  window.gtag?.('event','page_view',{send_to:property,page_path:path,page_title:document.title});
}
export function enableTracking(id) {
  if (!/^G-[A-Z0-9]{4,20}$/.test(id || '')) return;
  if (property && property !== id) { disableTracking(); return; }
  property = id; allowed = true; window[`ga-disable-${id}`] = false;
  trackConsentPage();
}
