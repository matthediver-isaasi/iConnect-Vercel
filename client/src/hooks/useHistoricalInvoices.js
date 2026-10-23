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

// Read every archive page before exposing a globally sortable timeline. Never
// substitute partial results when a later page fails.
export async function fetchAllHistoricalInvoices(options) {
  const first = await fetchHistoricalInvoices({ ...options, page: 0 });
  const records = [...first.records];
  const total = first.total;
  let canAccessInvoices = first.canAccessInvoices;
  for (let page = 1; page * HISTORICAL_INVOICES_PAGE_SIZE < total; page += 1) {
    const next = await fetchHistoricalInvoices({ ...options, page });
    if (next.total !== total) {
      throw new Error("Historical invoices changed while loading. Please retry.");
    }
    records.push(...next.records);
    canAccessInvoices = canAccessInvoices && next.canAccessInvoices;
  }
  const unique = [...new Map(records.map(record => [record.id, record])).values()];
  if (unique.length !== total) {
    throw new Error("Historical invoices could not be fully loaded. Please retry.");
  }
  return { records: unique, total, canAccessInvoices };
}

export function useAllHistoricalInvoices({ memberId, activeTenantId = null, enabled = true, request = fetch }) {
  const tenantId = useHistoricalInvoiceTenant(activeTenantId);
  return useQuery({
    queryKey: historicalInvoicesQueryKey(tenantId, memberId, "all"),
    queryFn: ({ signal }) => fetchAllHistoricalInvoices({ memberId, tenantId, signal, request }),
    enabled: !!memberId && enabled,
    retry: false,
  });
}
