import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const PAGE_SIZE = 25;

const words = (value) =>
  String(value || "Unknown")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const actorSummary = (event) => {
  const metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return (
    metadata.actor_name ||
    metadata.actor_email ||
    metadata.actor ||
    (event.actor_id ? `${words(event.actor_type)} · ${event.actor_id}` : words(event.actor_type || "system"))
  );
};

function JsonDetail({ title, value }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      {value == null ? (
        <p className="text-sm text-slate-500">No data</p>
      ) : (
        <pre className="max-h-72 overflow-auto rounded-md border bg-slate-950 p-3 text-xs text-slate-100">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function AuditRow({ event }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = event.before_data != null || event.after_data != null;
  const time = event.created_at ? new Date(event.created_at) : null;
  return (
    <div className="border-b last:border-0">
      <button
        type="button"
        className="grid w-full gap-2 px-4 py-4 text-left hover:bg-slate-50 md:grid-cols-[150px_minmax(180px,1fr)_minmax(180px,1fr)_190px_28px] md:items-center"
        onClick={() => hasDetails && setExpanded((current) => !current)}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <span>
          <Badge variant="outline" className="w-fit">{words(event.action)}</Badge>
          {event.id && <span className="mt-1 block truncate font-mono text-[11px] text-slate-400" title={event.id}>Event {event.id.slice(0, 8)}</span>}
        </span>
        <span className="text-sm text-slate-700">
          <span className="font-medium text-slate-900">{words(event.entity_type)}</span>
          {event.entity_id && <span className="block truncate font-mono text-xs text-slate-500">{event.entity_id}</span>}
        </span>
        <span className="truncate text-sm text-slate-600" title={actorSummary(event)}>{actorSummary(event)}</span>
        <span
          className="text-sm text-slate-500"
          title={time && !Number.isNaN(time.valueOf()) ? time.toISOString() : undefined}
        >
          {time && !Number.isNaN(time.valueOf()) ? time.toLocaleString() : "Unknown time"}
        </span>
        {hasDetails && (expanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />)}
      </button>
      {expanded && (
        <div className="grid gap-4 border-t bg-slate-50/70 px-4 py-4 lg:grid-cols-2">
          <JsonDetail title="Before" value={event.before_data} />
          <JsonDetail title="After" value={event.after_data} />
        </div>
      )}
    </div>
  );
}

export function AuditHistory({ objectId, request }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [objectId]);
  const query = useQuery({
    queryKey: ["custom-objects", objectId, "audit", page],
    queryFn: () => request(`/api/custom-objects/${objectId}/audit?page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: (previous) => previous,
    retry: false,
  });
  const events = query.data?.data || [];
  const total = query.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => {
    if (!query.isFetching && page > pages) setPage(pages);
  }, [page, pages, query.isFetching]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Audit history</CardTitle>
        <CardDescription>Read-only schema and record activity for this custom object. Expand an event to inspect its stored before and after values.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="hidden grid-cols-[150px_minmax(180px,1fr)_minmax(180px,1fr)_190px_28px] gap-2 border-y bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 md:grid">
          <span>Action</span><span>Entity</span><span>Actor</span><span>Time</span><span />
        </div>
        {query.isLoading ? (
          <div className="grid h-40 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
        ) : query.error ? (
          <div className="py-12 text-center">
            <p className="font-medium text-rose-700">Audit history could not be loaded</p>
            <p className="mt-1 text-sm text-slate-600">{query.error.message}</p>
            <Button variant="outline" className="mt-4" onClick={() => query.refetch()}>Try again</Button>
          </div>
        ) : events.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-500">No audit events have been recorded for this object.</p>
        ) : events.map((event) => <AuditRow key={event.id} event={event} />)}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
          <span className="text-slate-500">{total} event{total === 1 ? "" : "s"}</span>
          <div className="flex items-center gap-2">
            <Button size="icon" variant="outline" aria-label="Previous audit page" disabled={page <= 1 || query.isFetching} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <span>Page {page} of {pages}</span>
            <Button size="icon" variant="outline" aria-label="Next audit page" disabled={page >= pages || query.isFetching} onClick={() => setPage((value) => value + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}