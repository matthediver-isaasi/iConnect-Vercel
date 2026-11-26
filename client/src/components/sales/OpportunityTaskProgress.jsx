import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock3, ListTodo, RefreshCw, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PAGE_SIZE = 10;

async function fetchTaskProgress(page) {
  const params = new URLSearchParams({
    view: "task-progress",
    taskProgressPage: String(page),
    taskProgressPageSize: String(PAGE_SIZE),
  });
  const response = await fetch(`/api/sales/reports?${params}`, { credentials: "include" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Unable to load opportunity task progress (${response.status})`);
  }
  if (!Array.isArray(payload?.items) || !payload?.summary) {
    throw new Error("Opportunity task progress returned an incomplete response. Please retry.");
  }
  return payload;
}

function number(value) {
  return value == null ? "—" : Number(value).toLocaleString();
}

function percent(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function utcTimestamp(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Date unavailable";
  const part = (item) => String(item).padStart(2, "0");
  return `${part(date.getUTCDate())}/${part(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ${part(date.getUTCHours())}:${part(date.getUTCMinutes())} UTC`;
}

function SummaryMetric({ label, value, icon: Icon, tone }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200/80 bg-[#f8faf9] px-3 py-3 sm:px-4">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${tone}`}><Icon className="h-4 w-4" aria-hidden="true" /></span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 text-lg font-semibold tabular-nums leading-tight text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function AccessLabel({ status }) {
  if (status === "restricted") {
    return <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900">Restricted board</span>;
  }
  if (status === "unavailable") {
    return <span className="inline-flex items-center rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">Board unavailable</span>;
  }
  return null;
}

function OpportunityRow({ item }) {
  const available = item.status === "available";
  const metrics = available
    ? [
      ["Tasks", item.totalTasks === 0 ? "No tasks" : number(item.totalTasks)],
      ["Open", number(item.openTasks)],
      ["Overdue", number(item.overdueTasks)],
      ["Complete", item.totalTasks === 0 ? "No tasks" : percent(item.completionPercent)],
    ]
    : [];
  const completion = item.latestCompletion;
  const latestText = !available ? "Progress is not available with your current board access."
    : completion
      ? `${utcTimestamp(completion.at)} · Recorded by: ${completion.actorName || "Not recorded"}`
      : item.completedTasks > 0 ? "Completion date and person not recorded" : "No tasks completed";

  return (
    <li className="group rounded-lg border border-slate-200 bg-white px-4 py-4 transition-colors hover:border-[#99b8ac] hover:bg-[#fbfdfc] sm:px-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:max-w-[38%]">
          <Link
            to={`/sales/opportunities/${encodeURIComponent(String(item.id))}`}
            className="inline-flex max-w-full items-center gap-2 text-sm font-semibold text-[#244d3e] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#527d6c] focus-visible:ring-offset-2"
          >
            <span className="break-words">{item.name}</span>
            <span className="sr-only"> opportunity details</span>
          </Link>
          <div className="mt-2"><AccessLabel status={item.status} /></div>
        </div>
        {available && <dl className="grid grid-cols-2 gap-x-5 gap-y-3 sm:flex sm:flex-wrap sm:justify-end sm:gap-x-6 sm:gap-y-2">
          {metrics.map(([label, value]) => (
            <div key={label} className="min-w-[4.5rem] sm:text-right">
              <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-500">{label}</dt>
              <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>}
      </div>
      <p className="mt-3 flex items-start gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span><span className="font-medium text-slate-600">Latest completion:</span> {latestText}</span>
      </p>
    </li>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading opportunity task progress">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-[66px] animate-pulse rounded-lg bg-slate-100" />)}
      </div>
      {[0, 1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-lg border border-slate-100 bg-slate-50" />)}
      <span className="sr-only">Loading task progress</span>
    </div>
  );
}

export function OpportunityTaskProgress() {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["sales-reports", "task-progress", page, PAGE_SIZE],
    queryFn: () => fetchTaskProgress(page),
    staleTime: 30_000,
  });
  const data = query.data;
  const items = Array.isArray(data?.items) ? data.items : [];
  const summary = data?.summary || {};
  const pages = Math.max(1, Number(data?.pages) || 1);
  const restricted = Number(summary.restrictedOpportunities) || 0;
  const unavailable = Number(summary.unavailableOpportunities) || 0;

  return (
    <Card className="overflow-hidden border-[#dce7e1] shadow-sm" role="region" aria-labelledby="opportunity-task-progress-title">
      <CardHeader className="border-b border-[#e6eee9] bg-[#f6f9f7] px-4 py-4 sm:px-5">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-[#e4eee8] text-[#315e4b]"><ListTodo className="h-[18px] w-[18px]" aria-hidden="true" /></span>
          <div>
            <CardTitle id="opportunity-task-progress-title" className="text-base font-semibold tracking-[-0.01em] text-slate-900">Opportunity task progress</CardTitle>
            <p className="mt-0.5 text-xs text-slate-500">Work completed across commercial opportunities</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4 sm:p-5">
        {query.isLoading && <LoadingState />}
        {query.error && <div className="flex flex-col gap-4 rounded-lg border border-rose-200 bg-rose-50/70 p-4 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <div className="flex items-start gap-3 text-sm text-rose-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div><p className="font-semibold">Task progress could not be loaded</p><p className="mt-1 text-rose-800">{query.error.message}</p></div>
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0 border-rose-300 bg-white text-rose-900 hover:bg-rose-100" onClick={() => query.refetch()}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />Retry
          </Button>
        </div>}
        {!query.isLoading && !query.error && data && <>
           <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <SummaryMetric label="Opportunities" value={number(summary.opportunityCount)} icon={Target} tone="bg-[#e4eee8] text-[#315e4b]" />
            <SummaryMetric label="Tasks" value={number(summary.totalTasks)} icon={ListTodo} tone="bg-[#eaf0ed] text-[#48695b]" />
            <SummaryMetric label="Open" value={number(summary.openTasks)} icon={Clock3} tone="bg-[#f7f0df] text-[#82672d]" />
            <SummaryMetric label="Overdue" value={number(summary.overdueTasks)} icon={AlertTriangle} tone="bg-[#f8e9e6] text-[#995849]" />
            <SummaryMetric label="Weighted completion" value={percent(summary.completionPercent)} icon={Check} tone="bg-[#e8efe7] text-[#56734f]" />
          </div>
          {summary.partial && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-950" role="note">
            Partial totals: {number(restricted)} restricted and {number(unavailable)} unavailable {Number(summary.opportunityCount) === 1 ? "opportunity" : "opportunities"} excluded from task totals.
          </p>}
          {items.length === 0 ? <div className="rounded-lg border border-dashed border-[#cbd9d1] bg-[#fafcfb] px-5 py-8 text-center">
            <ListTodo className="mx-auto h-6 w-6 text-[#789486]" aria-hidden="true" />
            <p className="mt-2 text-sm font-semibold text-slate-800">No opportunities to show</p>
            <p className="mt-1 text-xs text-slate-500">Task progress will appear here when opportunities are available.</p>
          </div> : <ul className="space-y-2.5">{items.map((item) => <OpportunityRow key={item.id} item={item} />)}</ul>}
          <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-500" aria-live="polite">
              Page {Number(data.page) || page} of {pages}
              {data.total != null && <span> · {number(data.total)} opportunities</span>}
            </p>
            <div className="flex items-center gap-2 sm:ml-auto">
              <Button type="button" variant="outline" size="sm" aria-label="Previous opportunity task progress page" disabled={page <= 1 || query.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />Previous
              </Button>
              <Button type="button" variant="outline" size="sm" aria-label="Next opportunity task progress page" disabled={page >= pages || query.isFetching} onClick={() => setPage((current) => Math.min(pages, current + 1))}>
                Next<ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </>}
      </CardContent>
    </Card>
  );
}

export default OpportunityTaskProgress;
