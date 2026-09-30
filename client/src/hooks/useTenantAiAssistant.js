import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";

// The key includes the authenticated identity as well as the tenant. Never
// reuse a previous member's configuration while a new session is validating.
export function useTenantAiAssistant({ memberId, memberTenantId, sessionValidated, sessionScope }) {
  const activeTenantId = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  // Portal members have a verified tenant_id from /api/auth/me but no admin
  // tenant session. Never modify the global admin tenant to represent them.
  const tenantId = memberTenantId || null;
  const tenantMismatch = !!activeTenantId && !!tenantId && String(activeTenantId) !== String(tenantId);
  const identity = memberId && sessionValidated && tenantId && !tenantMismatch
    ? [tenantId, String(memberId), sessionScope]
    : null;
  const query = useQuery({
    queryKey: ["tenant-ai-assistant", ...(identity || ["inactive"])],
    enabled: !!identity,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/member-ai/config", {
        credentials: "include",
        headers: { "X-Tenant-Id": tenantId },
        signal,
      });
      if (!response.ok) throw new Error("Failed to load member assistant configuration");
      const config = await response.json();
      if (!config || config.tenantId !== tenantId || typeof config.enabled !== "boolean") {
        throw new Error("Invalid member assistant configuration");
      }
      return config;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return {
    ...query,
    tenantId,
    tenantMismatch,
    identityKey: identity?.join(":") || null,
    config: identity && !query.isError && query.data?.tenantId === tenantId ? query.data : null,
  };
}