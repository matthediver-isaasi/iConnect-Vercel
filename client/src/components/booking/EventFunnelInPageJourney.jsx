import React, { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { useQuery } from '@tanstack/react-query';
import { Ticket } from 'lucide-react';
import EventFunnelJourneyFrame from './EventFunnelJourneyFrame';
import EventFunnelCheckoutSlot from './EventFunnelCheckoutSlot';
import EventFunnelMembershipOffer, { AcceptedMembershipSummary } from './EventFunnelMembershipOffer';
import { safeAddonImageUrl } from './addonPresentation.mjs';
import { readEventFunnelOffer } from '@/hooks/useEventFunnelEntry';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { addonSelection, restoreAddonChoices, sourceAttendeePool } from '@/lib/eventFunnelInPage.mjs';
import { FUNNEL_PRESENTATION_ATTRS, FUNNEL_PRESENTATION_TAGS } from '../../../../shared/eventFunnelPresentation.mjs';
import './EventReservationIntegration.css';

const sanitize = html => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: FUNNEL_PRESENTATION_TAGS, ALLOWED_ATTR: FUNNEL_PRESENTATION_ATTRS,
  ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
});
const price = ticket => {
  const amount = Number(ticket.price) || 0;
  if (ticket.is_free || amount === 0) return 'Free';
  const currency = typeof ticket.currency === 'string' && ticket.currency ? ticket.currency.toUpperCase() : 'GBP';
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount); }
  catch { return `£${amount.toFixed(2)}`; }
};
const attendeeName = attendee => `${attendee.first_name || attendee.firstName || ''} ${attendee.last_name || attendee.lastName || ''}`.trim()
  || attendee.email || 'Attendee';

/**
 * Runs a funnel journey over the source event page. The page never changes:
 * optional steps repaint inside one modal, and checkout appears in place of the
 * Booking Summary. All changes still go through the owned journey commands.
 */
export default function EventFunnelInPageJourney({ sessionId, sourceLabel, onExit }) {
  return <div className="event-funnel-in-page" data-testid="event-funnel-in-page">
    <EventFunnelJourneyFrame sessionId={sessionId} sourceLabel={sourceLabel}
      renderBody={journey => <InPageBody {...journey} onExit={onExit} />} />
  </div>;
}

export function InPageBody({ snapshot, change, pending, refresh, checkoutEligibility, frozen, expired, blocked, canMutateOffer, onExit }) {
  const [closedNodeId, setClosedNodeId] = useState(null);
  const atCheckout = snapshot.route.atCheckout;
  const current = snapshot.graph.nodes.find(node => node.id === snapshot.route.currentNodeId);
  const stepNode = !atCheckout && current && ['addon', 'event', 'membership'].includes(current.type) ? current : null;
  const modalOpen = Boolean(stepNode && !frozen && !expired && closedNodeId !== stepNode.id);
  const confirmed = snapshot.session.state === 'confirmed';

  if (atCheckout) {
    return <div className="space-y-4" data-testid="event-funnel-in-page-checkout">
      <h3 className="text-lg font-semibold">Booking Summary</h3>
      <AcceptedMembershipSummary snapshot={snapshot} change={change} pending={pending} />
      <EventFunnelCheckoutSlot snapshot={snapshot} change={change} refresh={refresh}
        checkoutEligibility={checkoutEligibility} />
      {confirmed && <Button type="button" variant="outline" onClick={onExit}>Back to event</Button>}
    </div>;
  }
  return <div className="space-y-3">
    {stepNode && !modalOpen && !frozen && !expired && <Button type="button" className="w-full"
      onClick={() => setClosedNodeId(null)} data-testid="journey-step-reopen">Continue choosing your options</Button>}
    {!stepNode && <div className="event-reservation-notice" role="status">
      <p>Your reservation is waiting for the next step.</p>
      <Button type="button" variant="outline" className="mt-3" onClick={() => refresh()}>Check reservation</Button>
    </div>}
    <Dialog open={modalOpen} onOpenChange={open => { if (!open && stepNode) setClosedNodeId(stepNode.id); }}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto p-0" data-testid="journey-step-dialog">
        {stepNode?.type === 'membership' ? <div className="p-6">
          <DialogHeader className="mb-4">
            <DialogTitle>An offer for your booking</DialogTitle>
            <DialogDescription>Closing this window keeps your reservation unchanged.</DialogDescription>
          </DialogHeader>
          <EventFunnelMembershipOffer node={stepNode} offer={snapshot.membershipOffers?.[stepNode.id]}
            change={change} pending={pending || blocked} />
        </div> : stepNode ? <StepOffer key={`${stepNode.id}:${snapshot.session.revision}`} snapshot={snapshot}
          node={stepNode} change={change} disabled={pending || blocked} canMutateOffer={canMutateOffer} /> : null}
      </DialogContent>
    </Dialog>
  </div>;
}

function StepOffer({ snapshot, node, change, disabled, canMutateOffer }) {
  const offerQuery = useQuery({
    queryKey: ['owned-event-reservation-offer', snapshot.session.id, node.id, snapshot.session.revision],
    queryFn: () => readEventFunnelOffer(snapshot.session.id, node.id),
    retry: false, staleTime: 0,
  });
  const offer = offerQuery.data;
  const sourceAnswers = snapshot.drafts?.[snapshot.graph.entry] || {};
  const pool = useMemo(() => sourceAttendeePool(sourceAnswers), [sourceAnswers]);
  const [choices, setChoices] = useState(null);
  const [failure, setFailure] = useState(null);
  useEffect(() => { if (offer && choices === null) setChoices(restoreAddonChoices(pool, offer)); }, [offer, pool, choices]);

  const presentation = node.type === 'addon' && node.presentation ? node.presentation : {};
  const image = safeAddonImageUrl(presentation.imageUrl) || (node.type === 'event' ? safeAddonImageUrl(offer?.event?.image_url) : '');
  const heading = (typeof presentation.heading === 'string' && presentation.heading.trim())
    || (node.type === 'event' && offer?.event?.title) || 'An optional extra for your booking';
  const body = typeof presentation.bodyHtml === 'string' ? presentation.bodyHtml : '';
  const single = offer?.selectionMode === 'single';
  const selected = choices || {};
  const selection = addonSelection(sourceAnswers, pool, selected);

  function toggle(ticketId, index, on) {
    setChoices(previous => {
      const base = single ? Object.fromEntries(Object.entries(previous || {}).filter(([id]) => id === ticketId)) : { ...(previous || {}) };
      const list = new Set(base[ticketId] || []);
      if (on) list.add(index); else list.delete(index);
      return { ...base, [ticketId]: [...list] };
    });
  }
  async function submit(command) {
    setFailure(null);
    if (command.type === 'select' && !canMutateOffer()) {
      setFailure('Your reservation cannot be changed right now. Check its status and try again.');
      return;
    }
    try {
      const result = await change(command);
      if (!result) setFailure('We could not save that choice. Your reservation is unchanged.');
    } catch (cause) {
      setFailure(cause?.message || 'We could not save that choice. Your reservation is unchanged.');
    }
  }

  return <article data-testid="journey-step-offer" data-node-type={node.type}>
    {image && <img src={image} alt="" className="h-48 w-full rounded-t-lg object-cover sm:h-56" data-testid="journey-step-banner" />}
    <div className="space-y-4 p-6">
      <DialogHeader>
        <DialogTitle className="text-xl">{heading}</DialogTitle>
        <DialogDescription className="sr-only">Choose whether to add this to your booking. Closing this window keeps your reservation unchanged.</DialogDescription>
      </DialogHeader>
      {body && <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitize(body) }} />}

      {offerQuery.isError ? <div className="event-reservation-notice" role="alert">
        <p>These options could not be loaded. Your reservation has not changed.</p>
        <Button type="button" variant="outline" className="mt-3" onClick={() => offerQuery.refetch()}>Try again</Button>
      </div> : !offer ? <div className="event-reservation-loading" role="status">
        <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><p>Loading options…</p>
      </div> : <fieldset disabled={disabled} className="space-y-3" aria-label="Options">
        {offer.tickets.length === 0 && <p className="text-sm text-muted-foreground">No options are available to you at this step. You can skip it.</p>}
        {offer.tickets.map(ticket => {
          const id = String(ticket.id);
          const chosen = selected[id] || [];
          const remaining = Number.isFinite(ticket.remaining) ? ticket.remaining : null;
          const soldOut = ticket.is_sold_out === true;
          return <div key={id} className={`rounded-lg border-2 p-4 ${chosen.length ? 'border-blue-500 bg-blue-50' : 'border-slate-200'}`}
            data-testid={`journey-step-ticket-${id}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
                <div>
                  <p className="font-medium">{ticket.name}</p>
                  {ticket.description && <p className="text-sm text-slate-600">{ticket.description}</p>}
                </div>
              </div>
              <span className="shrink-0 font-semibold">{soldOut ? 'Sold out' : price(ticket)}</span>
            </div>
            {!soldOut && pool.length > 0 && <div className="mt-3 space-y-2">
              {pool.length > 1 && <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Add for</p>}
              {pool.map((attendee, index) => {
                const checked = chosen.includes(index);
                const full = !checked && remaining !== null && chosen.length >= remaining;
                const inputId = `step-${node.id}-${id}-${index}`;
                return <div key={inputId} className="flex items-center gap-2">
                  <Checkbox id={inputId} checked={checked} disabled={full}
                    onCheckedChange={value => toggle(id, index, value === true)} />
                  <label htmlFor={inputId} className="text-sm">{pool.length > 1 ? attendeeName(attendee) : `Add ${ticket.name}`}</label>
                </div>;
              })}
            </div>}
          </div>;
        })}
        {pool.length === 0 && <p role="alert" className="text-sm text-amber-700">Your attendee details could not be found for this reservation. Skip this step or check your reservation.</p>}
      </fieldset>}

      {failure && <p role="alert" className="text-sm text-red-700">{failure}</p>}
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={disabled} onClick={() => submit({ type: 'skip', nodeId: node.id })}
          data-testid="journey-step-skip">Skip</Button>
        <Button type="button" disabled={disabled || !offer || selection.tickets.length === 0}
          onClick={() => submit({ type: 'select', nodeId: node.id, tickets: selection.tickets, answers: selection.answers })}
          data-testid="journey-step-continue">Continue</Button>
      </div>
      <p className="text-xs text-muted-foreground">No booking or payment is made until checkout.</p>
    </div>
  </article>;
}
