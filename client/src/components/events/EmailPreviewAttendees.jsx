import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function EmailPreviewAttendees({ eventId, selected, onSelect }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState({ items: [], hasMore: false, loading: true, error: null });
  const request = useRef(0);
  const controller = useRef(null);

  async function load(offset = 0) {
    const id = ++request.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setPage(previous => ({ ...previous, loading: true, error: null }));
    try {
      const response = await fetch(`/api/event-emails/${eventId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.current.signal,
        body: JSON.stringify({ action: "attendees", search, offset }),
      });
      const result = await response.json();
      if (id !== request.current) return;
      if (!response.ok) throw new Error(result.error || `Attendees could not be loaded (${response.status})`);
      if (!Array.isArray(result.items)) throw new Error("Attendee list is unavailable. Please retry.");
      setPage(previous => ({
        items: offset ? [...previous.items, ...result.items] : result.items,
        hasMore: !!result.hasMore,
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (id !== request.current) return;
      setPage(previous => ({ ...previous, loading: false, error: error.message || "Attendees could not be loaded" }));
    }
  }

  useEffect(() => {
    load(0);
    return () => { request.current++; controller.current?.abort(); };
    // Each search owns its request; older responses must never replace its list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, search]);

  const name = attendee => [attendee.attendee_first_name, attendee.attendee_last_name].filter(Boolean).join(" ") || "Unnamed attendee";
  return (
    <section className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-2 shrink-0" aria-label="Preview attendee">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Preview as an attendee</p>
        <Button type="button" variant="outline" size="sm" aria-pressed={!selected} onClick={() => onSelect(null)}>
          Use sample attendee
        </Button>
      </div>
      <p className="text-xs text-slate-600">
        Confirmed bookings for this event only. Selecting an attendee previews their personal details and available join links; it never sends email or registers them for Zoom.
      </p>
      {selected && <p className="text-sm break-words" data-testid="email-preview-selected-attendee">
        Selected: <strong>{name(selected)}</strong> — {selected.attendee_email}
      </p>}
      <Label htmlFor="email-preview-attendee-search">Search attendees by name or email</Label>
      <Input id="email-preview-attendee-search" value={search} placeholder="Name or email address"
        onChange={event => {
          request.current++;
          controller.current?.abort();
          setPage({ items: [], hasMore: false, loading: true, error: null });
          setSearch(event.target.value);
        }} />
      <div className="max-h-36 overflow-y-auto space-y-1" aria-busy={page.loading} aria-live="polite">
        {page.items.map(attendee => (
          <button type="button" key={attendee.id}
            aria-pressed={selected?.id === attendee.id}
            className={`block w-full rounded border px-3 py-2 text-left text-sm break-words hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 ${selected?.id === attendee.id ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white"}`}
            onClick={() => onSelect(attendee)}>
            <span className="font-medium">{name(attendee)}</span>
            <span className="block text-xs text-slate-600">{attendee.attendee_email}</span>
          </button>
        ))}
        {page.loading && <div role="status" className="space-y-2 p-2">
          <span className="sr-only">Loading attendees...</span>
          <div className="h-4 w-2/3 rounded bg-slate-200 animate-pulse" />
          <div className="h-4 w-1/2 rounded bg-slate-200 animate-pulse" />
        </div>}
        {!page.loading && !page.error && !page.items.length && <p className="p-2 text-sm text-slate-600">
          {search ? "No confirmed attendees match your search. Try another name or use a sample." : "No confirmed attendees yet. You can still preview with sample details."}
        </p>}
      </div>
      {page.error && <div role="alert" className="text-sm text-red-700">
        <p>{page.error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => load(page.items.length)}>Retry attendees</Button>
      </div>}
      {page.hasMore && !page.error && <Button type="button" variant="outline" size="sm" disabled={page.loading} onClick={() => load(page.items.length)}>Load more attendees</Button>}
    </section>
  );
}
