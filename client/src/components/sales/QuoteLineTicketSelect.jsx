import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import QuoteEventSelect from "./QuoteEventSelect";

export default function QuoteLineTicketSelect({ line, disabled, onChange, request }) {
  const reference = line.eventReference;
  const required = line.type === "ticket";
  const options = useQuery({
    queryKey: ["quote-line-ticket-options", reference?.eventId, reference?.kind],
    queryFn: ({ signal }) => request(`/api/sales/catalogue/event-options?${new URLSearchParams({ ticketEvents: "true", selectedId: reference.eventId, kind: reference.kind })}`, { signal }),
    enabled: Boolean(reference?.eventId),
    retry: false,
  });
  const events = options.data?.items || [];
  const event = events.find(item => item.id === reference?.eventId && item.kind === reference?.kind);
  const ticket = event?.ticketOptions?.find(item => item.id === reference?.ticketTypeId);
  const frozenCapacity = line.catalogue_snapshot?.capacity_metadata?.delegate_capacity;
  const capacity = disabled ? frozenCapacity ?? ticket?.delegateCapacity : ticket?.delegateCapacity;
  return <div className="mt-3 rounded-md border bg-white p-3">
    <p className="mb-2 text-sm font-medium">{required ? "Ticket selection" : "Ticket allocation for this product"}</p>
    {options.error && <p role="alert" className="text-sm text-red-600">{options.error.message}<button type="button" className="ml-2 underline" onClick={() => options.refetch()}>Retry ticket types</button></p>}
    {event?.eligible === false && <p className="mb-2 text-sm text-slate-500">{event.unavailableReason || "This saved event is no longer available for new allocations."} The saved allocation is retained.</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label>Ticket event</Label><QuoteEventSelect ticketOnly disabled={disabled} value={reference?.eventId} kind={reference?.kind} request={request} onChange={selected => {
         if (required && !selected) return;
        if (selected && selected.id === reference?.eventId && selected.kind === reference?.kind) return;
        onChange(selected ? { kind: selected.kind, eventId: selected.id, ticketTypeId: "" } : null);
      }} /></div>
      {reference && <div><Label>Ticket type</Label><Select disabled={disabled || !event || options.isFetching || options.isError || event.eligible === false} value={reference.ticketTypeId || ""} onValueChange={ticketTypeId => { if (ticketTypeId) onChange({ ...reference, ticketTypeId }); }}><SelectTrigger><SelectValue placeholder={options.isFetching ? "Loading ticket types…" : "Choose ticket type"} /></SelectTrigger><SelectContent>
        {reference.ticketTypeId && !ticket && <SelectItem value={reference.ticketTypeId} disabled>Saved ticket type (unavailable)</SelectItem>}
        {(event?.ticketOptions || []).map(item => <SelectItem key={item.id} value={item.id}>{item.name}{item.delegateCapacity > 1 ? ` · ${item.delegateCapacity} delegates per ticket` : ""}</SelectItem>)}
      </SelectContent></Select></div>}
    </div>
    <p className="mt-2 text-xs text-slate-500">{reference
      ? reference.ticketTypeId && capacity ? `${line.quantity} tickets × ${capacity} delegate${capacity === 1 ? "" : "s"} per ticket = ${Number(line.quantity) * capacity} places. Quantity is tickets, not the total price.`
        : "Choose a ticket type to complete this allocation."
      : required ? "Choose a ticket event and ticket type for this line. The proposal header event is informational only." : "This line does not allocate tickets. The proposal header event is informational only."} Changes apply only to this proposal, not the catalogue.</p>
  </div>;
}
