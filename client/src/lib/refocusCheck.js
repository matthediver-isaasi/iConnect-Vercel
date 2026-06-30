/**
 * Proactive stale-tab detection on window refocus.
 *
 * When a backgrounded tab regains focus, this module immediately checks
 * whether the session's current tenant still matches the tenant this tab has
 * pinned. If they diverge it fires the existing `tenant-context-changed`
 * event, which causes StaleTenantOverlay to lock the tab before the user can
 * initiate any action.
 *
 * Exemptions (all handled by early-exit guards in checkStaleTenant):
 *  - No active tenant pinned → skip (covers unauthenticated pages, public
 *    portal pages, mobile/bearer sessions, and platform-owner sessions where
 *    no tenant id is set).
 *  - Overlay already visible → skip (no redundant network calls after locking).
 *  - Rapid focus/visibilitychange bursts → debounced to one check per burst.
 *  - Legitimate tenant-changing flows (login, logout, tenant-switch, portal
 *    handoff) reload the page, resetting _activeTenantId to null, so the
 *    check is naturally skipped in those windows.
 *
 * Heal-race prevention:
 *  The global fetch interceptor (fetchInterceptor.js) auto-overwrites
 *  _activeTenantId from every successful /api/auth/tenant-user-me response.
 *  A concurrent tenant-user-me response during the 400 ms debounce window
 *  could update _activeTenantId to the NEW tenant before checkStaleTenant
 *  reads it — making "old === new" and silently hiding the mismatch.
 *
 *  To prevent this, scheduleCheck() captures pinnedTenantId SYNCHRONOUSLY
 *  at the moment the focus event fires (before any debounce delay) and passes
 *  it as an argument to the async check. The interceptor cannot retroactively
 *  change a value that has already been snapshotted into a local variable.
 *
 * Cache-proof fetch:
 *  The refocus fetch uses `cache: 'no-store'` and a timestamp query parameter
 *  so the browser always goes to the network even if a prior tenant-user-me
 *  response is still cached. The server endpoint also returns Cache-Control:
 *  no-store so subsequent checks are never served from an HTTP cache.
 */

import { getActiveTenantId } from '@/api/base44Client';
import { emitTenantContextChanged } from '@/lib/queryClient';

let _overlayVisible = false;
let _debounceTimer = null;
const DEBOUNCE_MS = 400;

async function checkStaleTenant(pinnedTenantId) {
  // Skip when no tenant was pinned at focus time: unauthenticated, public
  // pages, bearer/mobile sessions, and platform-owner sessions all leave
  // _activeTenantId null so this guard covers all of those cases.
  if (!pinnedTenantId) return;

  // Skip if the overlay is already showing — tab is already locked.
  if (_overlayVisible) return;

  try {
    // Use cache: 'no-store' plus a timestamp cache-buster so the browser
    // always fetches from the network. Without this the browser may serve
    // the previous (stale-org) response from its HTTP cache, making the
    // comparison see "old === old" and miss the mismatch entirely.
    const res = await fetch(`/api/auth/tenant-user-me?_ts=${Date.now()}`, {
      credentials: 'include',
      cache: 'no-store',
    });

    // A non-200 response (network error, 401, 500) means we can't confirm
    // staleness — leave the tab usable and rely on the reactive 409 path.
    if (!res.ok) return;

    const body = await res.json().catch(() => null);
    if (!body) return;

    // Session is no longer authenticated — this is a logout, not a switch.
    // The app's own auth flow will handle the redirect; don't lock here.
    if (!body.authenticated) return;

    const sessionTenantId = body?.tenant?.id;

    // Authenticated but no tenant in the session means a platform-owner
    // session (no per-tenant context). Don't lock.
    if (!sessionTenantId) return;

    // Compare the live session tenant against the value captured synchronously
    // at focus time. The fetch interceptor may have already updated
    // _activeTenantId during this async window; we intentionally ignore that
    // and use the snapshot to detect a mismatch correctly.
    if (sessionTenantId !== pinnedTenantId) {
      emitTenantContextChanged();
    }
  } catch (_) {
    // Network failure — don't lock. The reactive 409 guard is the backstop.
  }
}

function scheduleCheck() {
  // Capture pinnedTenantId SYNCHRONOUSLY here, at focus-event time, before
  // the debounce delay begins. The fetch interceptor can overwrite
  // _activeTenantId during the 400 ms window (e.g. from a concurrent
  // tenant-user-me response triggered by another part of the app), so
  // snapshotting now prevents the heal race from hiding a real mismatch.
  const pinnedTenantId = getActiveTenantId();

  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => checkStaleTenant(pinnedTenantId), DEBOUNCE_MS);
}

/**
 * Install focus/visibilitychange listeners that proactively check for a
 * stale tab on refocus. Call once, early in the app lifecycle.
 */
export function installRefocusCheck() {
  if (typeof window === 'undefined') return;

  // Track overlay visibility so we can skip redundant checks once locked.
  window.addEventListener('tenant-context-changed', () => {
    _overlayVisible = true;
  });

  // visibilitychange fires when the user switches back to this tab (including
  // from another app). window focus fires when the browser window itself
  // regains focus. Both can trigger a stale-tab scenario; debouncing ensures
  // we only make one request even when both fire together.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleCheck();
    }
  });

  window.addEventListener('focus', () => {
    scheduleCheck();
  });
}
