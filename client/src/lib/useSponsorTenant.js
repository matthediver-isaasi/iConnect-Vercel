import { useSyncExternalStore } from "react";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";

export function useSponsorTenant() {
  return useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, getActiveTenantId);
}
