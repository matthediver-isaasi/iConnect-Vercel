import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuoteNaming } from "@/hooks/useSalesSettings";
import { quotePath } from "@shared/salesNaming.js";
import { formatDashboardDate } from "./dashboardDates.mjs";

export function SalesRecentActivity({ rows = [], query }) {
  const naming = useQuoteNaming();
  return <Card>
    <CardHeader><CardTitle className="text-base">Recent activity</CardTitle></CardHeader>
    <CardContent aria-busy={query?.isFetching || false} className="space-y-2">
      {query?.isLoading ? <p role="status" className="py-5 text-sm text-slate-500">Loading sales activity…</p>
        : query?.error ? <div role="alert" className="text-sm text-rose-700">
          <p>{query.error.message}</p>
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry activity</Button>
        </div>
          : !rows.length ? <p className="py-5 text-center text-sm text-slate-500">No sales milestones yet. Stage moves, sent {naming.plural.toLowerCase()} and recorded outcomes will appear here.</p>
            : rows.slice(0, 8).map(row => {
              const to = row.quoteId ? quotePath(naming, row.quoteId)
                : `/sales/opportunities/${encodeURIComponent(row.opportunityId)}`;
              const record = row.quoteId ? `${naming.singular}${row.quoteNumber ? ` ${row.quoteNumber}` : ""}`
                : row.opportunityName || "Opportunity";
              const description = String(row.description || "").replace(/\bProposal\b/g, naming.singular);
              return <Link key={row.id} to={to} className="block rounded-lg border p-3 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 break-words text-sm font-medium text-slate-900">{description}</p>
                  <time dateTime={row.date} className="shrink-0 text-xs text-slate-500">{formatDashboardDate(row.date)}</time>
                </div>
                <p className="mt-1 break-words text-sm text-slate-700">{record}</p>
                {row.quoteId && row.opportunityName && <p className="mt-0.5 break-words text-xs text-slate-500">{row.opportunityName}</p>}
                {row.organizationName && <p className="mt-0.5 break-words text-xs text-slate-500">{row.organizationName}</p>}
                <p className="mt-1 break-words text-xs text-slate-500">Recorded by: {row.actorName || "Actor not recorded"}</p>
              </Link>;
            })}
    </CardContent>
  </Card>;
}
