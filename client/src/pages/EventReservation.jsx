import React, { useEffect, useState } from 'react';
import EventFunnelMembershipOffer, { AcceptedMembershipSummary } from '@/components/booking/EventFunnelMembershipOffer';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { readEventFunnelOffer } from '@/hooks/useEventFunnelEntry';
import { EventReservationProvider } from '@/contexts/EventReservationContext';
import EventFunnelJourneyFrame from '@/components/booking/EventFunnelJourneyFrame';
import EventFunnelCheckoutSlot from '@/components/booking/EventFunnelCheckoutSlot';
import { Button } from '@/components/ui/button';
import { EventDetailsExperience } from './EventDetails';
import { ComplexEventDetailExperience } from './ComplexEventDetail';
import '@/components/booking/EventReservationIntegration.css';

function ReservationOffer({ snapshot, change, pending, nodeId, onSaved }) {
  const offerQuery = useQuery({
    queryKey: ['owned-event-reservation-offer', snapshot.session.id, nodeId, snapshot.session.revision],
    queryFn: () => readEventFunnelOffer(snapshot.session.id, nodeId),
    retry: false, staleTime: 0,
  });
  const offer = offerQuery.data;
  if (offerQuery.isError) return <section className="event-reservation-notice" role="alert">
    <h3>This event could not be loaded</h3>
    <p>Your saved reservation has not changed. Try loading the event again.</p>
    <Button type="button" variant="outline" className="mt-3" onClick={() => offerQuery.refetch()}>Try again</Button>
  </section>;
  if (!offer) return <div className="event-reservation-loading" role="status">
    <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
    <p>Loading event details…</p>
  </div>;
  if (offer.nodeId !== nodeId || !offer.event || !Array.isArray(offer.tickets)
    || !['simple', 'complex'].includes(offer.eventKind)) {
    return <div className="event-reservation-notice" role="alert">
      <h3>Event details could not be verified</h3>
      <p>No booking or payment has been submitted.</p>
    </div>;
  }
  async function select({ tickets, answers }) {
    const result = await change({ type: 'select', nodeId, tickets, answers });
    if (result) onSaved();
    return result;
  }
  const Experience = offer.eventKind === 'complex' ? ComplexEventDetailExperience : EventDetailsExperience;
  return <EventReservationProvider value={{ snapshot, offer, pending, select }}>
    <div className="event-reservation-reveal">
      <Experience key={`${snapshot.session.id}:${nodeId}`} eventId={offer.eventId} embedded />
    </div>
  </EventReservationProvider>;
}

function ReservationBody({ snapshot, change, pending, refresh, checkoutEligibility, renderEventFields }) {
  // Navigation changes the display only. It never mutates the route or sends
  // a client-selected destination; the server recomputes after every selection.
  const [displayed, setDisplayed] = useState(null);
  useEffect(() => { setDisplayed(null); }, [snapshot.session.revision]);
  const routeIds = Array.isArray(snapshot.route.route) ? snapshot.route.route : [];
  const reachable = snapshot.graph.nodes.filter(node =>
    ['source', 'event', 'addon'].includes(node.type)
      && (node.id === snapshot.route.currentNodeId || routeIds.includes(node.id)));
  const currentId = displayed && reachable.some(node => node.id === displayed) ? displayed : snapshot.route.currentNodeId;
  const checkout = !displayed && snapshot.route.atCheckout;
  const index = reachable.findIndex(node => node.id === currentId);
  const historicalNode = displayed && reachable.find(node => node.id === currentId);
  const membershipNode = !displayed && !checkout
    && snapshot.graph.nodes.find(node => node.id === snapshot.route.currentNodeId && node.type === 'membership');
  return <div data-viewing-history={Boolean(displayed)}>
    {renderEventFields(<>
    <nav className="event-reservation-nav" aria-label="Saved event selections">
      {(checkout || index > 0) && <Button type="button" variant="outline" disabled={pending}
        onClick={() => setDisplayed(reachable[checkout ? reachable.length - 1 : index - 1]?.id || null)}>
        Back to previous event
      </Button>}
      {displayed && <Button type="button" variant="ghost" disabled={pending}
        onClick={() => setDisplayed(null)}>Return to current step</Button>}
    </nav>
    {historicalNode && historicalNode.type !== 'source' && <Button type="button" variant="outline"
      className="mb-4" disabled={pending} onClick={async () => {
        const result = await change({ type: 'skip', nodeId: historicalNode.id });
        if (result) setDisplayed(null);
      }}>Remove this optional event</Button>}
    {membershipNode && <EventFunnelMembershipOffer node={membershipNode}
      offer={snapshot.membershipOffers?.[membershipNode.id]} change={change} pending={pending} />}
    {!checkout && !membershipNode && (reachable.some(node => node.id === currentId)
        ? <ReservationOffer key={currentId} snapshot={snapshot} change={change} pending={pending}
          nodeId={currentId} onSaved={() => setDisplayed(null)} />
        : <div className="event-reservation-notice" role="status">
          <h3>No event is available at this step</h3>
          <p>Check your reservation to load the latest available choices.</p>
          <Button type="button" variant="outline" className="mt-3" onClick={() => refresh()}>Check reservation</Button>
        </div>)}
    </>)}
    {checkout && <AcceptedMembershipSummary snapshot={snapshot} change={change} pending={pending} />}
    {checkout && <EventFunnelCheckoutSlot snapshot={snapshot} change={change} refresh={refresh}
      checkoutEligibility={checkoutEligibility} />}
  </div>;
}

export default function EventReservation() {
  const { search } = useLocation();
  const sessionId = new URLSearchParams(search).get('sessionId') || '';
  return <div className="event-reservation-page">
    <h1 className="mb-6 text-2xl font-semibold">Your event reservation</h1>
    <EventFunnelJourneyFrame sessionId={sessionId} renderBody={journey => <ReservationBody {...journey} />} />
  </div>;
}
