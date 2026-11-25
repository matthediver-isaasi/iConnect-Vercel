import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

const stateLabel = item => item.state === "consumed"
  ? `Applied to ${item.consumption?.membershipYear || "a membership period"}`
  : item.state === "withdrawn" ? "Withdrawn — the originating event booking was cancelled"
    : item.state === "reserved" ? "Held by a membership checkout in progress — review that payment"
    : "Available for the next matching period";
const money = minor => (Number(minor || 0) / 100).toFixed(2);
const date = value => value ? new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

/** Complimentary memberships granted by event funnel bookings (admin view). */
export default function FunnelMembershipEntitlements({ scope, recipientId }) {
  const param = scope === "member" ? "memberId" : "organizationId";
  const query = useQuery({
    queryKey: ["funnel-membership-entitlements", scope, recipientId],
    enabled: Boolean(recipientId),
    queryFn: async () => {
      const response = await fetch(`/api/membership/org-membership?action=funnel-entitlements&scope=${scope}&${param}=${encodeURIComponent(recipientId)}`, { credentials: "include" });
      if (response.status === 403) return { items: [], restricted: true };
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not load event booking membership benefits");
      return body;
    },
  });
  if (query.data?.restricted || query.data?.enabled === false) return null;
  if (query.isSuccess && !query.data?.items?.length) return null;
  return <section className="rounded-lg border p-4 space-y-3" aria-label="Event booking membership benefits" data-testid="funnel-membership-benefits">
    <h3 className="font-semibold">Event booking membership benefits</h3>
    {query.isPending ? <p role="status">Loading benefits…</p> : query.isError
      ? <p role="alert">{query.error.message} <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p>
      : query.data.items.map(item => <div className="rounded border p-3 text-sm space-y-1" key={item.id}>
        <p className="font-medium">{item.scheduleName || "Membership tier"} — {stateLabel(item)}</p>
        <p className="text-muted-foreground">From {item.source?.funnelName || "an event funnel"}{item.source?.orderedAt ? ` · booked ${date(item.source.orderedAt)}` : ""}{item.grantedAt ? ` · ${date(item.grantedAt)}` : ""}</p>
        <p>One period of base membership only. Add-ons remain payable. This benefit is not evidence of payment.</p>
        {item.consumption && <p>Original base fee {money(item.consumption.originalBaseNetMinor)} plus VAT {money(item.consumption.originalBaseVatMinor)}, waived in full.</p>}
      </div>)}
  </section>;
}
