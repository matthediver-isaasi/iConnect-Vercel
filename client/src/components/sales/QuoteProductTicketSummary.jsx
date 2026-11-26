import { useQuoteTicketEvent } from "./QuoteLineTicketSelect";

/** Read-only ticket link inherited from a catalogue product or a saved legacy line. */
export default function QuoteProductTicketSummary({ line, request }) {
  const reference = line.eventReference;
  const snapshot = line.catalogue_snapshot || line.catalogueSnapshot;
  const savedMatches = snapshot?.event_reference_kind === reference?.kind && snapshot?.event_id === reference?.eventId
    && String(snapshot?.ticket_type_id) === String(reference?.ticketTypeId);
  const needsLookup = Boolean(reference?.ticketTypeId) && !(savedMatches && snapshot?.event_title && snapshot?.ticket_name);
  const { event, ticket } = useQuoteTicketEvent(needsLookup ? reference : null, request);
  if (!reference?.eventId || !reference?.ticketTypeId) return null;
  const eventName = (savedMatches && snapshot?.event_title) || event?.name || "Event";
  const ticketName = (savedMatches && snapshot?.ticket_name) || ticket?.name || "Ticket";
  const capacity = (savedMatches && snapshot?.capacity_metadata?.delegate_capacity) || ticket?.delegateCapacity;
  return <div className="mt-3 rounded-md border bg-white p-3 text-sm">
    <p><span className="font-medium">Includes:</span> {eventName} — {ticketName}</p>
    <p className="mt-1 text-xs text-slate-500">{capacity ? `${line.quantity} tickets × ${capacity} delegate${capacity === 1 ? "" : "s"} per ticket = ${Number(line.quantity) * capacity} places. ` : ""}This ticket comes from the catalogue product and cannot be changed on the proposal. Add an Event ticket line to sell a different ticket.</p>
  </div>;
}
