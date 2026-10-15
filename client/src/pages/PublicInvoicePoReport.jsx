import { useId, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Search, RefreshCw } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { adminFetch } from "@/lib/adminFetch";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import PublicInvoicePoRegistrations from "@/components/events/PublicInvoicePoRegistrations";
import PublicInvoicePoFormAnswers from "@/components/events/PublicInvoicePoFormAnswers";

function ReportSkeleton() {
  return <div role="status" aria-label="Loading registrations" className="space-y-4 py-6">
    {[1, 2, 3].map(item => <div key={item} className="h-20 rounded-lg bg-muted animate-pulse" />)}
    <span className="sr-only">Loading registrations…</span>
  </div>;
}

function EventFilter({ events, selected, onSelect }) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const choices = events.filter(event => (event.title || "").toLowerCase().includes(search.toLowerCase()));
  const choose = event => {
    onSelect(event);
    setSearch(event?.title || "");
    setOpen(false);
    setActive(0);
  };
  return <div className="space-y-2">
    <label htmlFor={`${listId}-input`} className="text-sm font-medium">Event</label>
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="relative flex-1" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setSearch(selected?.title || "");
        }
      }}>
        <Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
        <Input id={`${listId}-input`} className="pl-9" role="combobox" autoComplete="off"
          aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          placeholder="Search events by title…" value={search}
          onFocus={() => { setOpen(true); setActive(0); }}
          onChange={event => { setSearch(event.target.value); setOpen(true); setActive(0); }}
          onKeyDown={event => {
            if (event.key === "Escape") { setOpen(false); setSearch(selected?.title || ""); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive(value => Math.max(0, Math.min(choices.length, value + (event.key === "ArrowDown" ? 1 : -1))));
            }
            if (event.key === "Enter" && open) { event.preventDefault(); choose(active === 0 ? null : choices[active - 1]); }
          }} />
        {open && <div id={listId} role="listbox" aria-label="Events" className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          <button type="button" id={`${listId}-0`} role="option" aria-selected={active === 0} className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent" onMouseDown={event => event.preventDefault()} onClick={() => choose(null)}>All events</button>
          {choices.map((event, index) => <button type="button" role="option" id={`${listId}-${index + 1}`} key={event.id} aria-selected={active === index + 1}
            className="w-full rounded px-3 py-2 text-left text-sm hover:bg-accent aria-selected:bg-accent"
            onMouseDown={event => event.preventDefault()} onClick={() => choose(event)}>
            <span className="block font-medium">{event.title}</span>
            <span className="text-xs text-muted-foreground">{event.start_date ? new Date(event.start_date).toLocaleDateString() : "Date not recorded"}{event.isComplex ? " · Complex event" : ""}</span>
          </button>)}
          {choices.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No events match this title.</p>}
        </div>}
      </div>
      <Button variant="outline" onClick={() => choose(null)}>All events</Button>
    </div>
    <p className="text-xs text-muted-foreground">{selected ? `Showing registrations for ${selected.title}.` : "Showing all events, including past events."}</p>
  </div>;
}

export default function PublicInvoicePoReport() {
  const { isAccessReady, isFeatureExcluded, memberInfo, sessionValidated } = useMemberAccess();
  const allowed = isAccessReady && sessionValidated && !!memberInfo?.tenant_id
    && !isFeatureExcluded("events.public-invoice-po-report");
  const identity = `${memberInfo?.tenant_id || ""}:${memberInfo?.id || ""}`;
  const [selection, setSelection] = useState(null);
  const selected = selection?.identity === identity ? selection.event : null;
  const query = useQuery({
    queryKey: ["public-invoice-po-report", identity, selected?.id || null],
    enabled: allowed,
    queryFn: async ({ signal }) => {
      const params = selected ? `?${new URLSearchParams({ eventId: selected.id })}` : "";
      const response = await adminFetch(`/api/reports/public-invoice-po${params}`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Unable to load public Invoice / PO registrations. Please try again.");
      return response.json();
    },
    retry: false,
    staleTime: 0,
  });
  // Keep the complete event catalogue available when a filtered response is returned.
  const [catalogue, setCatalogue] = useState(null);
  const events = catalogue?.identity === identity ? catalogue.events : query.data?.events || [];
  const groups = useMemo(() => query.data?.bookingGroups || [], [query.data]);
  if (!isAccessReady) return <ReportSkeleton />;
  if (!allowed) return <Navigate to={createPageUrl("Events")} replace />;
  return <main className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
    <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
      <div><h1 className="text-2xl md:text-3xl font-bold tracking-tight">Public Invoice / PO registrations</h1>
        <p className="mt-2 text-sm text-muted-foreground">Review purchaser, attendee and submitted form details across your events.</p></div>
      <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}><RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />Refresh</Button>
    </header>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><CalendarDays aria-hidden="true" className="h-4 w-4" />Filter registrations</CardTitle></CardHeader>
      <CardContent><EventFilter key={identity} events={events} selected={selected} onSelect={event => {
        if (!catalogue || catalogue.identity !== identity) setCatalogue({ identity, events });
        setSelection({ identity, event });
      }} /></CardContent></Card>
    {query.isLoading ? <ReportSkeleton /> : query.isError ? <Card><CardContent className="py-8 space-y-3">
      <h2 className="font-semibold">Registrations could not be loaded</h2>
      <p role="alert" className="text-sm text-destructive">{query.error.message}</p>
      <Button variant="outline" onClick={() => query.refetch()}>Retry</Button>
    </CardContent></Card> : query.data && <PublicInvoicePoRegistrations
      key={`${identity}:${selected?.id || "all"}`} groups={groups} allGroups={groups} organizations={query.data.organizations || {}}
      renderFormAnswers={(group, email) => <PublicInvoicePoFormAnswers group={group} email={email}
        submissions={query.data.formSubmissions || []} formsById={query.data.formsById || {}}
        labels={query.data.relationshipLabelsByRecordId || {}} />} />}
  </main>;
}
