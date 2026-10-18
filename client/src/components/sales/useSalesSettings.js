import { useContext, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import LayoutContext from "@/contexts/LayoutContext";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import {
  getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused, subscribeToViewerProtectedWork,
} from "@/lib/viewerProtectedWorkGate";

export async function salesSettingsRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include", ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const details = Array.isArray(data?.details) ? data.details.map(item => typeof item === "string" ? item : item?.message).filter(Boolean).join(" ") : "";
    const error = new Error(details || data?.message || (typeof data?.error === "string" ? data.error : data?.error?.message) || "The Sales request failed. Please retry.");
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

export function useSalesSettingsScope() {
  const context = useContext(LayoutContext);
  const tenant = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const generation = useSyncExternalStore(subscribeToViewerProtectedWork,
    getViewerProtectedWorkGeneration, getViewerProtectedWorkGeneration);
  const { memberInfo, sessionRoleSnapshot, authResolved, sessionValidated, sessionWorkPaused } = context;
  const ready = authResolved && !sessionWorkPaused && !isViewerProtectedWorkPaused()
    && (!memberInfo || (sessionValidated && (!tenant || tenant === memberInfo.tenant_id)));
  const scopeKey = JSON.stringify([tenant, memberInfo?.tenant_id, memberInfo?.id,
    sessionRoleSnapshot?.session_key, generation, ready]);
  return { scopeKey, ready, tenant, generation };
}

export function useSalesSettings(request = salesSettingsRequest, { enabled = true } = {}) {
  const { scopeKey, ready: scopeReady, tenant, generation } = useSalesSettingsScope();
  const ready = scopeReady && enabled;
  const queryKey = ["sales-settings", scopeKey];
  const qc = useQueryClient();
  const query = useQuery({
    queryKey, enabled: ready, retry: false, staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const result = await request("/api/sales/settings", {
        signal, headers: tenant ? { "X-Tenant-Id": tenant } : {},
      });
      if (!Number.isInteger(result?.version)
        || typeof result.showInternalCode !== "boolean" || typeof result.showSku !== "boolean") {
        throw new Error("Sales settings are incomplete. Reload after the settings migration is applied.");
      }
      return result;
    },
  });
  const accept = async result => {
    await qc.cancelQueries({ queryKey, exact: true });
    qc.setQueryData(queryKey, old => !old || result.version >= old.version ? result : old);
  };
  return {
    ...query, scopeKey, queryKey, ready: ready && query.isSuccess && !query.isError,
    lastConfirmedData: ready ? query.data : undefined,
    data: ready && !query.isError ? query.data : undefined,
    patch: patch => {
      if (!ready || getActiveTenantId() !== tenant || getViewerProtectedWorkGeneration() !== generation
        || isViewerProtectedWorkPaused()) throw new Error("Your tenant or session changed. Reload before saving.");
      return request("/api/sales/settings", {
        method: "PATCH", headers: tenant ? { "X-Tenant-Id": tenant } : {},
        body: JSON.stringify(patch),
      });
    },
    // Both settings cards share the same authoritative version. Their local
    // drafts are deliberately independent of unrelated server fields.
    accept,
    publish: accept,
  };
}
