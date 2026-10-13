import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActiveTenantId, subscribeToActiveTenantId } from "@/api/base44Client";

export const HISTORICAL_INVOICES_PAGE_SIZE = 50;

export function historicalInvoicesQueryKey(tenantId, memberId, page = 0) {
  return ["historical-invoices", tenantId, memberId, page];
}

export function useHistoricalInvoiceTenant(fallback = null) {
  const activeTenantId = useSyncExternalStore(subscribeToActiveTenantId, getActiveTenantId, () => null);
  return activeTenantId || fallback;
}

export async function fetchHistoricalInvoices({ memberId, page = 0, tenantId, signal, request = fetch }) {
  const params = new URLSearchParams({ memberId, page: String(page) });
  const response = await request(`/api/membership/historical-invoices?${params}`, {
    credentials: "include",
    signal,
    headers: tenantId ? { "X-Tenant-Id": tenantId } : {},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Failed to load historical invoices");
  if (!Array.isArray(payload.records) || !Number.isInteger(payload.total) || payload.total < 0
    || typeof payload.canAccessInvoices !== "boolean") {
    throw new Error("Invalid historical invoices response");
  }
  return payload;
}

export function useHistoricalInvoices({ memberId, page = 0, activeTenantId = null, request = fetch }) {
  const tenantId = useHistoricalInvoiceTenant(activeTenantId);
  return useQuery({
    queryKey: historicalInvoicesQueryKey(tenantId, memberId, page),
    queryFn: ({ signal }) => fetchHistoricalInvoices({ memberId, page, tenantId, signal, request }),
    enabled: !!memberId,
    retry: false,
  });
}
