import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import QuoteEventSelect from "./QuoteEventSelect";

const money = (minor, currency) => {
  if (minor == null) return "—";
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP" }).format(Number(minor) / 100); }
  catch { return `${currency || ""} ${(Number(minor) / 100).toFixed(2)}`.trim(); }
};

export function ticketOptionsQueryKey(reference, currency) {
  return ["quote-line-ticket-options", reference?.eventId, reference?.kind, currency || ""];
}

// Shared read of one Sales ticket event, including ticket price and VAT.
export function useQuoteTicketEvent(reference, request, currency) {
  const options = useQuery({
    queryKey: ticketOptionsQueryKey(reference, currency),
    queryFn: ({ signal }) => request(`/api/sales/catalogue/event-options?${new URLSearchParams({
      ticketEvents: "true", selectedId: reference.eventId, kind: reference.kind, ...(currency ? { currency } : {}),
    })}`, { signal }),
    enabled: Boolean(reference?.eventId && reference?.kind),
    retry: false,
  });
  const event = (options.data?.items || []).find(item => item.id === reference?.eventId && item.kind === reference?.kind);
  const ticket = event?.ticketOptions?.find(item => String(item.id) === String(reference?.ticketTypeId));
  return { options, event, ticket };
}

export function ticketVatText(ticket) {
  if (!ticket) return "";
  if (ticket.taxCode?.name) return ticket.taxCode.name;
  const percentage = ticket.vat?.percentage;
  const label = ticket.vat?.label || (percentage != null ? `${percentage}%` : "No VAT set on this ticket");
  return label;
}

/**
 * Event ticket line: event, then ticket type. Everything else (description,
 * standard unit price and VAT) comes from the selected ticket.
 */
export default function QuoteLineTicketSelect({ line, disabled, onChange, request, currency }) {
  const reference = line.eventReference;
  const { options, event, ticket } = useQuoteTicketEvent(reference, request, currency);
  const frozenCapacity = line.catalogue_snapshot?.capacity_metadata?.delegate_capacity;
  const capacity = disabled ? frozenCapacity ?? ticket?.delegateCapacity : ticket?.delegateCapacity ?? frozenCapacity;
  return <div className="mt-3 rounded-md border bg-white p-3">
    <p className="mb-2 text-sm font-medium">Event ticket</p>
    {options.error && <p role="alert" className="text-sm text-red-600">{options.error.message}<button type="button" className="ml-2 underline" onClick={() => options.refetch()}>Retry ticket types</button></p>}
    {event?.eligible === false && <p className="mb-2 text-sm text-slate-500">{event.unavailableReason || "This saved event is no longer available for new allocations."} The saved allocation is retained.</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label>Event</Label><QuoteEventSelect ticketOnly disabled={disabled} value={reference?.eventId} kind={reference?.kind} request={request} onChange={selected => {
        if (!selected) return;
        if (selected.id === reference?.eventId && selected.kind === reference?.kind) return;
        onChange({ kind: selected.kind, eventId: selected.id, ticketTypeId: "" }, null);
      }} /></div>
      {reference && <div><Label>Ticket type</Label><Select disabled={disabled || !event || options.isFetching || options.isError || event.eligible === false} value={reference.ticketTypeId || ""} onValueChange={ticketTypeId => {
        if (!ticketTypeId || ticketTypeId === reference.ticketTypeId) return;
        const chosen = event?.ticketOptions?.find(item => String(item.id) === String(ticketTypeId));
        onChange({ ...reference, ticketTypeId }, chosen ? { ...chosen, eventName: event.name } : null);
      }}><SelectTrigger aria-label="Ticket type"><SelectValue placeholder={options.isFetching ? "Loading ticket types…" : "Choose ticket type"} /></SelectTrigger><SelectContent>
        {reference.ticketTypeId && !ticket && <SelectItem value={reference.ticketTypeId} disabled>Saved ticket type (unavailable)</SelectItem>}
        {(event?.ticketOptions || []).map(item => <SelectItem key={item.id} value={String(item.id)}>{item.name}{item.delegateCapacity > 1 ? ` · ${item.delegateCapacity} delegates per ticket` : ""}</SelectItem>)}
      </SelectContent></Select></div>}
    </div>
    {ticket && !disabled && (ticket.priceUnavailableReason
      ? <p role="alert" className="mt-2 text-sm text-rose-700">{ticket.priceUnavailableReason}</p>
      : <p className="mt-2 text-xs text-slate-600">Ticket price {money(ticket.grossUnitPriceMinor, ticket.priceCurrency)} incl. VAT ({money(ticket.unitPriceMinor, ticket.priceCurrency)} net){ticket.isEarlyBird ? " · early bird price" : ""} · VAT: {ticketVatText(ticket)}</p>)}
    <p className="mt-2 text-xs text-slate-500">{reference
      ? reference.ticketTypeId && capacity ? `${line.quantity} tickets × ${capacity} delegate${capacity === 1 ? "" : "s"} per ticket = ${Number(line.quantity) * capacity} places. Quantity is tickets, not the total price.`
        : "Choose a ticket type to complete this line."
      : "Choose the event, then the ticket type. The description, price and VAT come from the ticket."}</p>
  </div>;
}
