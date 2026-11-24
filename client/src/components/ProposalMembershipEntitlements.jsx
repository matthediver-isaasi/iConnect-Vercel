import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

export default function ProposalMembershipEntitlements({ organizationId }) {
  const query = useQuery({
    queryKey: ["org-membership", organizationId, "proposal-entitlements"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const response = await fetch(`/api/membership/org-membership?action=proposal-entitlements&organizationId=${encodeURIComponent(organizationId)}`, { credentials: "include" });
      if (response.status === 403) return { items: [], restricted: true };
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load proposal membership benefits");
      return body;
    },
  });
  if (query.data?.restricted || query.data?.enabled === false) return null;
  return <section className="rounded-lg border p-4 space-y-3" aria-label="Proposal membership benefits">
    <h3 className="font-semibold">Proposal membership benefits</h3>
    {query.isPending ? <p role="status">Loading benefits…</p> : query.isError
      ? <p role="alert">{query.error.message} <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p>
      : !query.data?.items?.length ? <p className="text-sm text-muted-foreground">No proposal membership benefits recorded.</p>
      : query.data.items.map(item => <div className="rounded border p-3 text-sm space-y-1" key={item.id}>
        <p className="font-medium">{item.scheduleName} — {item.state === "consumed" ? `Applied to ${item.consumption.membership_year}` : "Available for the next matching period"}</p>
        {item.sourceProposalId && <Link className="underline" to={`/sales/quotes/${item.sourceProposalId}`}>Source proposal</Link>}
        <p>One period of base membership only. Add-ons remain payable. Acceptance is not evidence of invoice payment.</p>
        {item.consumption && <p>{item.history?.currency} original base fee: {(Number(item.consumption.original_base_net_minor) / 100).toFixed(2)} plus VAT {(Number(item.consumption.original_base_vat_minor) / 100).toFixed(2)}.
          Complimentary adjustment: the full base fee and its VAT. Remaining fee: {Number(item.history?.total_with_vat ?? item.history?.final_cost).toFixed(2)}.</p>}
        {item.invoiceState === "restricted" ? <p>Sales access is required to view proposal invoices.</p>
          : item.invoiceState === "not_issued" ? <p>No proposal invoice has been issued yet. Later staged invoices will appear here.</p>
          : <ul>{item.invoices.map(invoice => <li key={invoice.id}>
            {invoice.provider}: {invoice.url ? <a className="underline" href={invoice.url} target="_blank" rel="noopener noreferrer">{invoice.number}</a> : invoice.number} — {invoice.status}
          </li>)}</ul>}
      </div>)}
  </section>;
}
