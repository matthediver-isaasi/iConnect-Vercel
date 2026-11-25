import React from 'react';
import { BadgeCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

const recipientCopy = (offer) => offer.scope === 'organization'
  ? 'It is added to your organisation’s membership record.'
  : offer.recipientMode === 'attendees'
    ? 'Each named attendee on your qualifying booking receives it. Every attendee needs a member record.'
    : 'It is added to your own membership record.';

/**
 * Complimentary membership offer in the public journey. Accepting records an
 * eligibility request only: it adds no charge and does not start a membership.
 */
export default function EventFunnelMembershipOffer({ node, offer, change, pending }) {
  const available = offer?.available === true;
  return <div className="event-reservation-notice" data-testid="journey-membership-offer" role="group"
    aria-labelledby={`membership-offer-${node.id}`}>
    <h3 id={`membership-offer-${node.id}`} className="flex items-center gap-2">
      <BadgeCheck size={18} aria-hidden="true" />
      {available ? `Complimentary membership: ${offer.name}` : 'Complimentary membership unavailable'}
    </h3>
    {available ? <>
      <p>This covers one membership period at no charge. {recipientCopy(offer)}</p>
      {offer.description && <p className="mt-2 whitespace-pre-line">{offer.description}</p>}
      <p className="mt-2 text-sm text-muted-foreground">Accepting adds nothing to your checkout total. The membership is not started now: the base fee is waived once, when that membership period is next created. Any add-ons and later periods are charged normally.</p>
    </> : <p>This membership offer is no longer available. Decline it to continue with your booking.</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      {available && <Button type="button" disabled={pending} data-testid="journey-membership-accept"
        onClick={() => change({ type: 'membership', nodeId: node.id, decision: 'accept' })}>Accept complimentary membership</Button>}
      <Button type="button" variant="outline" disabled={pending} data-testid="journey-membership-decline"
        onClick={() => change({ type: 'membership', nodeId: node.id, decision: 'skip' })}>No thanks</Button>
    </div>
  </div>;
}

export function AcceptedMembershipSummary({ snapshot, change, pending }) {
  const accepted = snapshot?.route?.acceptedMembershipNodeIds || [];
  if (!accepted.length) return null;
  return <div className="event-reservation-notice" data-testid="journey-membership-accepted">
    <h3>Complimentary membership included</h3>
    <ul className="mt-2 list-disc pl-5">{accepted.map(id => {
      const offer = snapshot.membershipOffers?.[id];
      return <li key={id}>{offer?.name || 'Membership offer'} — one period at no charge.{' '}
        <Button type="button" variant="link" className="h-auto p-0" disabled={pending}
          onClick={() => change({ type: 'membership', nodeId: id, decision: 'skip' })}>Remove</Button></li>;
    })}</ul>
  </div>;
}
