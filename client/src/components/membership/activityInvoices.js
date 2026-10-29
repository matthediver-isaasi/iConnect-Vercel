import { useQuery } from "@tanstack/react-query";
import { fetchHistoricalInvoices, HISTORICAL_INVOICES_PAGE_SIZE, useHistoricalInvoiceTenant } from "@/hooks/useHistoricalInvoices";
import { validActivityDate } from "@/lib/memberActivityDates";

// Keep the Activity opt-in isolated from historical-only archive caches and reads.
export function activityInvoicesQueryKey(tenantId, memberId) {
  return ["member-activity-invoices", tenantId, memberId, "all", { includeMembership: true }];
}

export async function fetchAllHistoricalInvoices({ request = fetch, ...options }) {
  const activityRequest = (url, init) => {
    const [path, query] = url.split("?");
    const params = new URLSearchParams(query);
    params.set("includeMembership", "true");
    return request(`${path}?${params}`, init);
  };
  const readPage = async page => {
    try {
      return await fetchHistoricalInvoices({ ...options, page, request: activityRequest });
    } catch (error) {
      throw new Error(error.message.replace(/historical invoices/gi, "invoices"));
    }
  };
  const first = await readPage(0);
  const records = [...first.records];
  let canAccessInvoices = first.canAccessInvoices;
  for (let page = 1; page * HISTORICAL_INVOICES_PAGE_SIZE < first.total; page += 1) {
    const next = await readPage(page);
    if (next.total !== first.total) throw new Error("Invoices changed while loading. Please retry.");
    records.push(...next.records);
    canAccessInvoices = canAccessInvoices && next.canAccessInvoices;
  }
  const unique = [...new Map(records.map(record => [
    `${record.source === "membership" ? "membership" : "historical"}:${record.id}`, record,
  ])).values()];
  if (unique.length !== first.total) throw new Error("Invoices could not be fully loaded. Please retry.");
  return { records: unique, total: first.total, canAccessInvoices };
}

export function useAllHistoricalInvoices({ memberId, activeTenantId = null, enabled = true, request = fetch }) {
  const tenantId = useHistoricalInvoiceTenant(activeTenantId);
  return useQuery({
    queryKey: activityInvoicesQueryKey(tenantId, memberId),
    queryFn: ({ signal }) => fetchAllHistoricalInvoices({ memberId, tenantId, signal, request }),
    enabled: !!memberId && enabled,
    retry: false,
  });
}

export function mergeHistoricalInvoiceActivity(activity, records) {
  const invoices = records.map(record => ({
    key: `${record.source === "membership" ? "membership" : "historical"}-invoice-${record.id}`,
    id: record.id,
    source: "historical_invoice",
    record,
    date: validActivityDate(record.source === "membership" ? record.activity_date : record.invoice_date),
  }));
  const timestamp = value => validActivityDate(value) ? new Date(value).getTime() : -Infinity;
  return [...activity, ...invoices].sort((a, b) => {
    const left = timestamp(a.date);
    const right = timestamp(b.date);
    return left === right ? a.key.localeCompare(b.key) : left > right ? -1 : 1;
  });
}
