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
 * Critical ordering note:
 *  The global fetch interceptor (fetchInterceptor.js) auto-overwrites
 *  _activeTenantId from every successful /api/auth/tenant-user-me response.
 *  To avoid silently "healing" the stale state, we capture the pinned tenant
 *  id BEFORE the fetch call and compare against that snapshot — not against
 *  getActiveTenantId() after the call returns.
 */

import { getActiveTenantId } from '@/api/base44Client';
import { emitTenantContextChanged } from '@/lib/queryClient';

let _overlayVisible = false;
let _debounceTimer = null;
const DEBOUNCE_MS = 400;

async function checkStaleTenant() {
  // Skip when no tenant is pinned: unauthenticated, public pages,
  // bearer/mobile sessions, and platform-owner sessions all leave
  // _activeTenantId null so this guard covers all of those cases.
  const pinnedTenantId = getActiveTenantId();
  if (!pinnedTenantId) return;

  // Skip if the overlay is already showing — tab is already locked.
  if (_overlayVisible) return;

  try {
    // Capture pinnedTenantId BEFORE the request. The fetch interceptor will
    // call setActiveTenantId() from the response body, overwriting
    // _activeTenantId. We must compare against the pre-call snapshot or the
    // mismatch would be silently healed instead of triggering the lock.
    const res = await fetch('/api/auth/tenant-user-me', { credentials: 'include' });

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

    if (sessionTenantId !== pinnedTenantId) {
      emitTenantContextChanged();
    }
  } catch (_) {
    // Network failure — don't lock. The reactive 409 guard is the backstop.
  }
}

function scheduleCheck() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(checkStaleTenant, DEBOUNCE_MS);
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
