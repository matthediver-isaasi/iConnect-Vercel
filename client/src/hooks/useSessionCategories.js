import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";
import { adminFetch } from "@/lib/adminFetch";
import { activeSessionCategories } from "@/lib/sessionCategories";
import { getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused, subscribeToViewerProtectedWork } from "@/lib/viewerProtectedWorkGate";

export function useSessionCategories({ memberInfo, isAccessReady }) {
  const tenantIntent = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  const generation = useSyncExternalStore(subscribeToViewerProtectedWork, getViewerProtectedWorkGeneration, getViewerProtectedWorkGeneration);
  // Portal editors may never visit AdminDashboard, so verified member context
  // must work without the dashboard tenant-intent singleton.
  const tenantId = memberInfo?.tenant_id || tenantIntent;
  const ready = isAccessReady && !!tenantId && !isViewerProtectedWorkPaused()
    && (!memberInfo?.tenant_id || !tenantIntent || memberInfo.tenant_id === tenantIntent);
  const query = useQuery({
    queryKey: ["session-resource-categories", tenantId, memberInfo?.id, memberInfo?.role_id, generation],
    enabled: ready,
    queryFn: async ({ signal }) => {
      const response = await adminFetch('/api/complex-event-sessions?catalogue=true', { signal, cache: 'no-store' }, tenantId);
      if (!response.ok) throw new Error('Categories could not be loaded');
      const categories = await response.json();
      // Do not let an in-flight request populate another tenant's catalogue.
      if (getActiveTenantId() !== tenantIntent || getViewerProtectedWorkGeneration() !== generation || isViewerProtectedWorkPaused()) throw new Error("The active association changed. Retry loading categories.");
      if (!Array.isArray(categories)) throw new Error("Invalid category catalogue response");
      return activeSessionCategories(categories);
    },
    retry: false,
  });
  return ready ? query : { ...query, data: undefined, isPending: true };
}
