import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adminFetch } from "@/lib/adminFetch";

export const PUBLIC_INVOICE_PO_BILLING_KEY = ["public-invoice-po-billing"];
export const PUBLIC_INVOICE_PO_BILLING_ENDPOINT = "/api/admin/public-invoice-po-billing";

async function readResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.reason || "Invoice details could not be updated. Please try again.");
  return data;
}

export function usePublicInvoicePoBilling({ bookingId, isComplex, tenantId, viewerId }) {
  const client = useQueryClient();
  const queryKey = [...PUBLIC_INVOICE_PO_BILLING_KEY, tenantId, viewerId, bookingId, !!isComplex];
  const billing = useQuery({
    queryKey,
    queryFn: async ({ signal }) => readResponse(await adminFetch(
      `${PUBLIC_INVOICE_PO_BILLING_ENDPOINT}?${new URLSearchParams({ bookingId, isComplex: String(!!isComplex) })}`,
      { credentials: "include", signal },
    )),
    enabled: !!bookingId,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: query => ["queued","pending","processing","retry"].includes(query.state.data?.invoice?.status || query.state.data?.status) ? 5000 : false,
  });
  const generate = useMutation({
    mutationFn: async fingerprint => readResponse(await adminFetch(PUBLIC_INVOICE_PO_BILLING_ENDPOINT, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId, isComplex: !!isComplex, fingerprint }),
    })),
    onSuccess: data => {
      client.setQueryData(queryKey, data);
      client.invalidateQueries({ queryKey });
      client.invalidateQueries({ queryKey: ["event-registration-report"] });
      client.invalidateQueries({ queryKey: ["public-invoice-po-report"] });
    },
    onError: () => { client.invalidateQueries({ queryKey }); },
    retry: false,
  });
  return { billing, generate };
}
