import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function TaskLoading() {
  return <div role="status" aria-label="Loading tasks" className="space-y-3">
    {[1, 2, 3].map((row) => <div key={row} className="h-16 animate-pulse rounded-lg bg-muted" />)}
  </div>;
}
export function TaskError({ error, onRetry }) {
  return <Card className="border-destructive/30"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
    <p role="alert" className="text-sm text-destructive">{error?.message || "Could not load tasks."}</p>
    <Button variant="outline" onClick={onRetry}>Retry</Button>
  </CardContent></Card>;
}
export function TaskSummary({ summary }) {
  return <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[
    ["total", "Total tasks"], ["outstanding", "Outstanding"], ["completed", "Completed"], ["overdue", "Overdue"],
  ].map(([key, label]) => <div key={key} className="rounded-lg border bg-card px-4 py-3">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className={`mt-1 text-xl font-semibold tabular-nums ${key === "overdue" && summary?.[key] ? "text-destructive" : ""}`}>{summary?.[key] ?? 0}</dd>
  </div>)}</dl>;
}
export function TaskPagination({ page, total = 0, pageSize = 25, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
    <span>{total} results · Page {page} of {pages}</span>
    <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button></div>
  </div>;
}
