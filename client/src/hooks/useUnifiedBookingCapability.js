import { useQuery } from "@tanstack/react-query";
import { adminFetch } from "@/lib/adminFetch";

// Share only identity-scoped discovery, never a payment attempt or customer
// selection. Historical saved payment payloads keep their own version.
export function useUnifiedBookingCapability({ eventId, source = "simple", tenantId, viewerId, enabled = true }) {
  return useQuery({
    queryKey: ["unified-booking-customer", tenantId || null, viewerId || null, source, eventId],
    enabled: enabled && !!eventId,
    queryFn: async ({ signal }) => {
      const response = await adminFetch("/api/event-invoice-address", {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unified: true, eventId, source }),
      }, tenantId);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to check invoice customer choices");
      return data;
    },
    retry: false, staleTime: 0,
  });
}
