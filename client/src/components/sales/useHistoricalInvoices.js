import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveTenantId } from "@/api/base44Client";
import { getViewerProtectedWorkGeneration, isViewerProtectedWorkPaused } from "@/lib/viewerProtectedWorkGate";
import { salesSettingsRequest, useSalesSettingsScope } from "./useSalesSettings";

export function useHistoricalInvoices(quoteId, canManage, disabled, savedRevision) {
  const { scopeKey, ready, tenant, generation } = useSalesSettingsScope();
  const qc = useQueryClient();
  const inFlight = useRef(false);
  const endpoint = `/api/sales/quotes/${encodeURIComponent(quoteId || "")}?action=historical-invoices`;
  const headers = tenant ? { "X-Tenant-Id": tenant } : {};
  const query = useQuery({
    queryKey: ["sales-historical-invoices", scopeKey, quoteId, savedRevision],
    enabled: ready && Boolean(quoteId), retry: false,
    queryFn: ({ signal }) => salesSettingsRequest(endpoint, { headers, signal }),
  });
  const sessionCurrent = () => ready && Boolean(quoteId) && getActiveTenantId() === tenant
    && getViewerProtectedWorkGeneration() === generation && !isViewerProtectedWorkPaused();
  const actionReady = sessionCurrent() && canManage && !disabled && query.isSuccess && !query.isFetching && !query.isError;
  const latest = useRef(null);
  latest.current = { actionReady, data: query.data, sessionCurrent };
  const record = useMutation({
    mutationFn: async ({ groupId, invoiceNumber, confirmed }) => {
      const current = latest.current;
      if (!current.actionReady || !current.sessionCurrent()) throw new Error("Save the proposal and reload billing stages before recording an invoice.");
      if (inFlight.current) throw new Error("Another invoice is being recorded. Please wait.");
      const stage = current.data?.stages?.find(row => row.groupId === groupId);
      if (!stage?.canRecord || stage.invoiceNumber != null || current.data?.versionId == null || !stage.groupSnapshot || typeof stage.groupSnapshot !== "object") throw new Error("This stage is not available. Reload billing stages.");
      const number = String(invoiceNumber || "").trim();
      if (!number || number.length > 100 || confirmed !== true) throw new Error("Enter an invoice number and confirm that it covers this stage.");
      inFlight.current = true;
      try {
        const result = await salesSettingsRequest(endpoint, {
          method: "POST", headers,
          body: JSON.stringify({ versionId: current.data.versionId, groupId, invoiceNumber: number, expectedGroup: stage.groupSnapshot }),
        });
        if (!current.sessionCurrent()) throw new Error("Your tenant or session changed. Reload this proposal.");
        return result;
      } finally { inFlight.current = false; }
    },
    onSuccess: async () => {
      if (!sessionCurrent()) return;
      await Promise.all([
        query.refetch(),
        qc.invalidateQueries({ queryKey: ["sales-invoice-schedules", scopeKey] }),
      ]);
    },
    // A conflict may mean another user has already linked this stage.
    onError: error => { if (error.status === 409 && sessionCurrent()) query.refetch(); },
  });
  return { ...query, data: sessionCurrent() ? query.data : undefined, actionReady, record, scopeKey };
}
