import React from 'react';
import DOMPurify from 'dompurify';
import { useQuery } from '@tanstack/react-query';
import { readEventFunnelOffer } from '@/hooks/useEventFunnelEntry';
import { Button } from '@/components/ui/button';

export default function AddonEventBackdrop({ snapshot, node }) {
  const query = useQuery({
    queryKey: ['owned-event-reservation-offer', snapshot.session.id, node.id, snapshot.session.revision],
    queryFn: () => readEventFunnelOffer(snapshot.session.id, node.id),
    retry: false,
  });
  const offer = query.data;
  if (offer && (offer.nodeId !== node.id || !offer.event)) return <section
    className="event-reservation-notice" role="status" aria-label="Current event details">
    <p className="text-xs font-semibold uppercase tracking-wide">Current event · read only</p>
    <h3>{node.event?.title || node.event?.name || 'Your selected event'}</h3>
    <p>Event details could not be verified. Your saved reservation is unchanged.</p>
  </section>;
  if (query.isError) return <section className="event-reservation-notice" role="status" aria-label="Current event details">
    <p className="text-xs font-semibold uppercase tracking-wide">Current event · read only</p>
    <h3>{node.event?.title || node.event?.name || 'Your selected event'}</h3>
    <p>Event details are temporarily unavailable. Your saved reservation is unchanged.</p>
    <Button type="button" variant="outline" onClick={() => query.refetch()}>Try again</Button>
  </section>;
  if (!offer) return <section className="event-reservation-notice" aria-label="Current event details" role="status">
    <p className="text-xs font-semibold uppercase tracking-wide">Current event · read only</p>
    <div className="event-reservation-loading"><span aria-hidden="true" /><span aria-hidden="true" /></div>
  </section>;
  const event = offer.event || {};
  const selectedTickets = Array.isArray(offer.selectedTickets) ? offer.selectedTickets : [];
  return <section className="event-reservation-notice" aria-label="Current event details" data-testid="addon-event-context">
    <p className="text-xs font-semibold uppercase tracking-wide">Current event · read only</p>
    <h3>{event.title || node.event?.title || node.event?.name || 'Your selected event'}</h3>
    {event.start_date && <p>{event.start_date}</p>}
    {event.description && <div className="prose prose-sm max-w-none"
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(event.description) }} />}
    {selectedTickets.length > 0 && <div>
      <p className="text-sm font-medium">Your saved ticket selection</p>
      <ul>{selectedTickets.map((ticket, index) => <li key={ticket.id || index}>
        {ticket.name || ticket.title || 'Selected ticket'}{Number(ticket.quantity) > 1 ? ` · ${ticket.quantity}` : ''}
      </li>)}</ul>
    </div>}
    <p className="text-sm">This event information is read-only while you consider an optional extra.</p>
  </section>;
}
