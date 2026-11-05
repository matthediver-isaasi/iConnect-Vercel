import { popupFrequencyAllows } from "../../../shared/cmsPopupContract.js";

const views = new Map();
let currentView = null;
function readView(key, pathname) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(`cms-popup-view:${key}`) || "null");
    if (saved?.pathname === pathname) return { ...saved, consumed: new Set(saved.consumed || []) };
  } catch { /* SSR, denied storage or malformed data: memory only */ }
  return null;
}
function saveView(key, view) {
  try { window.sessionStorage.setItem(`cms-popup-view:${key}`, JSON.stringify({ pathname: view.pathname, enteredAt: view.enteredAt, consumed: [...view.consumed] })); }
  catch { /* Per-history in-memory fallback. */ }
}
export function consumePopupView(view, scope) {
  view.consumed.add(scope);
  for (const [key, value] of views) if (value === view) saveView(key, view);
}
export function releasePopupHistoryView(view) {
  if (currentView === view) currentView = null;
}
export function popupHistoryView(key, pathname) {
  const known = views.get(key) || readView(key, pathname);
  if (known?.pathname === pathname) { views.set(key, known); currentView = known; return known; }
  if (currentView?.pathname === pathname) {
    views.set(key, currentView);
    saveView(key, currentView);
    return currentView;
  }
  currentView = { pathname, consumed: new Set(), enteredAt: Date.now() };
  views.set(key, currentView);
  return currentView;
}
export function triggerReady(trigger, elapsedMs, scrollY, scrollHeight, viewportHeight) {
  const value = Number(trigger?.value || 0);
  if (!Number.isFinite(value) || value < 0) return false;
  switch (trigger?.type) {
    case "immediate": return true;
    case "delay": return elapsedMs >= value * 1000;
    case "scroll_pixels": return scrollY >= value;
    case "scroll_percent": return value <= 100 && scrollY / Math.max(1, scrollHeight - viewportHeight) * 100 >= value;
    default: return false;
  }
}
export function rankPopupCandidates(candidates) {
  return [...candidates].sort((a, b) => Number(b.config?.priority || 0) - Number(a.config?.priority || 0) || a.id.localeCompare(b.id));
}
export function frequencyAllows(frequency, last, now, timezone = "UTC") {
  if (!last) return true;
  if (frequency?.type === "session") return false;
  if (!frequency || !["page_view", "until_dismissed", "n_days", "day"].includes(frequency.type)) return false;
  try { return popupFrequencyAllows(frequency, { last_shown_at: last }, timezone, now); }
  catch { return false; }
}
export function popupStorageKey(tenant, viewer, popup) {
  return `cms-popup:${tenant}:${viewer}:${popup.id}:${popup.dismissal_generation}`;
}

export function mergePopupPreferenceState(durable, session, volatile) {
  const latest = (values) => values.filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  return {
    // Monotonic opt-outs: a later "false" object cannot undo a permanent choice.
    permanent: [durable, session, volatile].some((state) => state?.permanent === true),
    // Browser-session data never inherits suppression or frequency from disk.
    session: [session, volatile].some((state) => state?.session === true),
    sessionLast: latest([session?.last, volatile?.last]),
    last: latest([durable?.last, session?.last, volatile?.last]),
  };
}

export function popupDurableStorageAllowed(consent) {
  // useCookieConsent.hasConsented is specifically analytics consent, not a
  // generic "accepted some cookies" boolean. Keep that policy explicit here.
  return consent?.isLoaded === true && consent.isPending === false
    && consent.hasConsented === true && consent.categories?.analytics === true;
}
