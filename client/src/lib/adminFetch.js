/**
 * adminFetch — a thin wrapper around the native fetch API for admin pages.
 *
 * Every request made through this wrapper:
 *   1. Automatically includes the `X-Tenant-Id` header so the server can
 *      detect stale-tab tenant mismatches on the shared admin host (iconn.app).
 *   2. Detects a 409 TENANT_CONTEXT_CHANGED response and emits the global
 *      `tenant-context-changed` event so the StaleTenantOverlay is shown.
 *
 * Usage — drop-in replacement for fetch():
 *
 *   import { adminFetch } from "@/lib/adminFetch";
 *
 *   const res = await adminFetch("/api/admin/something", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify(payload),
 *     credentials: "include",
 *   });
 */

import { getActiveTenantId } from "@/api/base44Client";
import { emitTenantContextChanged } from "@/lib/queryClient";

export async function adminFetch(url, options = {}) {
  const tenantId = getActiveTenantId();

  const headers = new Headers(options.headers || {});
  if (tenantId) {
    headers.set("X-Tenant-Id", tenantId);
  }

  const response = await fetch(url, {
    credentials: "include",
    ...options,
    headers,
  });

  if (response.status === 409) {
    try {
      const body = await response.clone().json();
      if (body?.code === "TENANT_CONTEXT_CHANGED") {
        emitTenantContextChanged();
      }
    } catch (_) {}
  }

  return response;
}
