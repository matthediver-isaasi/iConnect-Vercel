import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { salesSettingsRequest, useSalesSettingsScope } from "./useSalesSettings";
import { getActiveTenantId } from "@/api/base44Client";
import { getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused } from "@/lib/viewerProtectedWorkGate";

export function useInvoiceSchedules(saleId, enabled, canManage = false) {
  const { scopeKey, ready, tenant, generation } = useSalesSettingsScope();
  const inFlight = useRef(false);
  const endpoint = `/api/sales/accounting/${encodeURIComponent(saleId || "")}`;
  const headers = tenant ? { "X-Tenant-Id": tenant } : {};
  const query = useQuery({
    queryKey: ["sales-invoice-schedules", scopeKey, saleId],
    enabled: ready && enabled && Boolean(saleId), retry: false,
    queryFn: ({ signal }) => salesSettingsRequest(`${endpoint}?action=schedules`, { signal, headers }),
  });
  const sessionCurrent = () => ready && enabled && Boolean(saleId) && getActiveTenantId() === tenant
    && getViewerProtectedWorkGeneration() === generation && !isViewerProtectedWorkPaused();
  const actionReady = sessionCurrent() && canManage && query.isSuccess && !query.isError && !query.isFetching;
  const command = async (action, input) => {
    if (!actionReady || !sessionCurrent()) throw new Error("Reload the accepted sale and resolve any loading errors before changing invoice groups.");
    if (inFlight.current) throw new Error("Another group operation is in progress. Wait before trying again.");
    const value = typeof input === "string" ? { scheduleId: input } : input || {};
    const body = { scheduleId: value.scheduleId };
    if (!body.scheduleId) throw new Error("Select an invoice group.");
    if (action === "retry-schedule" && value.confirmCustomerMatch === true) {
      if (!value.providerCustomerId) throw new Error("Select the intended accounting customer before confirming.");
      body.providerCustomerId = value.providerCustomerId;
      body.confirmCustomerMatch = true;
    }
    inFlight.current = true;
    try {
      return await salesSettingsRequest(`${endpoint}?action=${action}`, { method: "POST", headers, body: JSON.stringify(body) });
    } finally { inFlight.current = false; }
  };
  const reload = () => sessionCurrent() ? query.refetch() : undefined;
  const retry = useMutation({ mutationFn: value => command("retry-schedule", value), onSuccess: reload });
  const refresh = useMutation({ mutationFn: scheduleId => command("refresh-schedule", scheduleId), onSuccess: reload });
  return { ...query, data: ready && enabled ? query.data : undefined, actionReady, retry, refresh, scopeKey };
}
