import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function QuoteLineTicketSelect({ line, disabled, onChange, request }) {
  const options = useQuery({
    queryKey: ["quote-line-ticket-options"],
    queryFn: () => request("/api/sales/catalogue/event-options"),
    retry: false,
  });
  const reference = line.eventReference;
  const events = options.data?.items || [];
  const event = events.find(item => item.id === reference?.eventId && item.kind === reference?.kind);
  const ticket = event?.ticketOptions?.find(item => item.id === reference?.ticketTypeId);
  const frozenCapacity = line.catalogue_snapshot?.capacity_metadata?.delegate_capacity;
  const capacity = disabled ? frozenCapacity || ticket?.delegateCapacity : ticket?.delegateCapacity;
  return <div className="mt-3 rounded-md border bg-white p-3">
    <p className="mb-2 text-sm font-medium">Ticket allocation for this product</p>
    {options.error && <p role="alert" className="text-sm text-red-600">{options.error.message}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label>Ticket event</Label><Select disabled={disabled || options.isPending} value={reference ? `${reference.kind}:${reference.eventId}` : "none"} onValueChange={value => {
        const selected = events.find(item => `${item.kind}:${item.id}` === value);
        onChange(selected ? { kind: selected.kind, eventId: selected.id, ticketTypeId: "" } : null);
      }}><SelectTrigger><SelectValue placeholder="Choose event" /></SelectTrigger><SelectContent>
        <SelectItem value="none">No ticket allocation</SelectItem>
        {events.map(item => <SelectItem key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>{item.name} ({item.kind === "complex" ? "Enterprise" : "Simple"})</SelectItem>)}
      </SelectContent></Select></div>
      {reference && <div><Label>Ticket type</Label><Select disabled={disabled || !event} value={reference.ticketTypeId || ""} onValueChange={ticketTypeId => onChange({ ...reference, ticketTypeId })}><SelectTrigger><SelectValue placeholder="Choose ticket type" /></SelectTrigger><SelectContent>
        {(event?.ticketOptions || []).map(item => <SelectItem key={item.id} value={item.id}>{item.name}{item.delegateCapacity > 1 ? ` · ${item.delegateCapacity} delegates per ticket` : ""}</SelectItem>)}
      </SelectContent></Select></div>}
    </div>
    <p className="mt-2 text-xs text-slate-500">{reference
      ? reference.ticketTypeId && capacity ? `${line.quantity} tickets × ${capacity} delegate${capacity === 1 ? "" : "s"} per ticket = ${Number(line.quantity) * capacity} places. Quantity is tickets, not the total price.`
        : "Choose a ticket type to complete this allocation."
      : "This line does not allocate tickets. The proposal header event is informational only."} Changes apply only to this proposal, not the catalogue.</p>
  </div>;
}
