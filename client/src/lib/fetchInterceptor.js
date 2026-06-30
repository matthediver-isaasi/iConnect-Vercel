/**
 * Global fetch interceptor for admin API requests.
 *
 * Patches window.fetch once at startup so that EVERY call to /api/* that
 * includes credentials automatically:
 *   1. Carries the X-Tenant-Id header (lets the server detect stale tabs
 *      on the shared admin host iconn.app where the hostname alone cannot
 *      identify the intended tenant).
 *   2. Detects a 409 TENANT_CONTEXT_CHANGED response and fires the global
 *      tenant-context-changed event so StaleTenantOverlay locks the tab.
 *
 * This covers every admin page — including ones that use raw fetch() and
 * were not individually updated to use adminFetch().
 *
 * Call installFetchInterceptor() once, early in the app lifecycle (main.jsx).
 */

import { getActiveTenantId, setActiveTenantId } from "@/api/base44Client";
import { emitTenantContextChanged } from "@/lib/queryClient";

let interceptorInstalled = false;

export function installFetchInterceptor() {
  if (interceptorInstalled || typeof window === "undefined") return;
  interceptorInstalled = true;

  const _originalFetch = window.fetch.bind(window);

  window.fetch = async function interceptedFetch(input, init = {}) {
    // Only intercept /api/ requests
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url ?? "";
    const isApiCall = url.startsWith("/api/") || url.includes("/api/");
    const hasCredentials = init?.credentials === "include" || init?.credentials === "same-origin";

    if (isApiCall && hasCredentials) {
      const tenantId = getActiveTenantId();
      if (tenantId) {
        // Merge X-Tenant-Id without mutating the caller's options object
        const existingHeaders = init.headers instanceof Headers
          ? init.headers
          : new Headers(init.headers || {});
        if (!existingHeaders.has("X-Tenant-Id")) {
          existingHeaders.set("X-Tenant-Id", tenantId);
        }
        init = { ...init, headers: existingHeaders };
      }
    }

    const response = await _originalFetch(input, init);

    if (isApiCall) {
      // Auto-bootstrap _activeTenantId from any successful tenant-user-me
      // response so every admin page — including ones that don't explicitly
      // call setActiveTenantId() — has the intended-tenant header populated
      // before making subsequent mutations.
      if (url.includes("/api/auth/tenant-user-me") && response.status === 200) {
        try {
          const body = await response.clone().json();
          if (body?.authenticated && body?.tenant?.id) {
            setActiveTenantId(body.tenant.id);
          }
        } catch (_) {}
      }

      // Detect stale-tab 409 on any API call (not just credentialed ones,
      // in case some call sites omit explicit credentials)
      if (response.status === 409) {
        try {
          const body = await response.clone().json();
          if (body?.code === "TENANT_CONTEXT_CHANGED") {
            emitTenantContextChanged();
          }
        } catch (_) {
          // Non-JSON 409 — ignore
        }
      }
    }

    return response;
  };
}
