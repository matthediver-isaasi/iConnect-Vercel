import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuoteNaming } from "@/hooks/useSalesSettings";
import { quotePath } from "@shared/salesNaming.js";
import { formatDashboardDate } from "./dashboardDates.mjs";
import { netMoney } from "./salesNetMoney.mjs";

const text = value => typeof value === "string" && value.trim() ? value.trim() : null;

export function OutstandingProposalSummary({ rows = [], total = rows.length }) {
  const naming = useQuoteNaming();
  return <Card>
    <CardHeader>
      <CardTitle className="text-base">Outstanding {naming.plural}</CardTitle>
      <p className="text-sm text-slate-500">{total} outstanding {naming.plural.toLowerCase()}{total > 8 ? ` · Showing ${Math.min(rows.length, 8)} of ${total}` : ""}. Totals exclude tax.</p>
      <Link className="w-fit text-sm font-medium text-blue-700 underline focus-visible:outline focus-visible:outline-2" to={quotePath(naming)}>View all {naming.plural.toLowerCase()}</Link>
    </CardHeader>
    <CardContent className="space-y-2">
      {!rows.length && <p className="py-5 text-sm text-slate-500">No outstanding {naming.plural.toLowerCase()}.</p>}
      {rows.slice(0, 8).map((row, index) => {
        const content = <div className="flex min-w-0 flex-col justify-between gap-3 sm:flex-row">
          <div className="min-w-0 space-y-1 break-words">
            <p className="text-sm font-semibold text-slate-900">{text(row.quoteNumber) || `${naming.singular} reference not recorded`}</p>
            <p className="text-sm text-slate-700">{text(row.organisationName) || "Organisation not recorded"}</p>
            {text(row.opportunityName) && <p className="text-xs text-slate-500">Opportunity: {row.opportunityName}</p>}
            <Badge variant="outline">{text(row.status) ? row.status.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()) : "Status not recorded"}</Badge>
          </div>
          <div className="shrink-0 space-y-1 sm:text-right">
            <p className="text-sm font-semibold">{netMoney(row.netMinor, row.currency)}</p>
            <p className="text-xs text-slate-500">{text(row.date) && Number.isFinite(Date.parse(row.date))
              ? <>Issued: <time dateTime={row.date}>{formatDashboardDate(row.date)}</time></> : "Issued date not recorded"}</p>
          </div>
        </div>;
        const classes = "block rounded-lg border p-3 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600";
        return row.quoteId ? <Link key={row.id || index} to={quotePath(naming, row.quoteId)} className={classes}>{content}</Link>
          : <div key={row.id || index} className={classes}>{content}</div>;
      })}
    </CardContent>
  </Card>;
}
