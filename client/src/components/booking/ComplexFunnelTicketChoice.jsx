import React, { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock } from 'lucide-react';
import AttendeeOptionsSelector from '@/components/booking/AttendeeOptionsSelector';
import RegistrationAssociationField from '@/components/booking/RegistrationAssociationField';
import { useOwnedEventReservation } from '@/contexts/EventReservationContext';
import { useUnifiedBookingCapability } from '@/hooks/useUnifiedBookingCapability';
import { getEffectiveTicketPrice } from '@/lib/ticketPricing';
import { ticketMemberPolicy } from '@/utils/publicTicketMembers';
import { ticketReleaseMessage } from '../../../../shared/ticketRelease.js';
import {
  chooseFunnelTicket, emptyGuestAttendee, funnelAttendee, funnelChosenTicketId, guestAttendeeIssues,
  memberSelfAttendee, updateFunnelAttendee,
} from '@/lib/complexFunnelSelection.mjs';

// Funnel layout for complex events: choose one ticket, the person booking is
// the attendee, details are entered on the page. No pop-up and no cart.
export default function ComplexFunnelTicketChoice({
  eventId, tickets, cart, setCart, memberInfo, organizationInfo, eventOptions, requireJobTitle,
  isSoldOut, isRestricted, isReleaseBlocked, getRemaining, showAvailability, renderTrackAccess, disabled = false,
  onReadyChange,
}) {
  const owned = useOwnedEventReservation();
  const capability = useUnifiedBookingCapability({ eventId, source: 'complex', viewerId: memberInfo?.id,
    tenantId: memberInfo?.tenant_id, enabled: !owned && !memberInfo });
  const unified = !owned && capability.data?.version === 2 && capability.data.enabled;
  const chosenId = funnelChosenTicketId(cart);
  const chosen = tickets.find(ticket => String(ticket.id) === chosenId) || null;
  const current = funnelAttendee(cart);
  const [guest, setGuest] = useState(() => current && !memberInfo ? current : emptyGuestAttendee());
  const [touched, setTouched] = useState(false);

  // Keep the member's own details current if their profile loads after a choice.
  const memberKey = memberInfo ? [memberInfo.id, memberInfo.email, organizationInfo?.name].join('|') : '';
  useEffect(() => {
    if (!memberInfo || !chosenId) return;
    setCart(previous => {
      const ticket = previous[chosenId]?.ticketClass;
      return ticket ? chooseFunnelTicket(ticket, memberSelfAttendee(memberInfo, organizationInfo, funnelAttendee(previous))) : previous;
    });
  }, [memberKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const attendee = memberInfo ? (current || memberSelfAttendee(memberInfo, organizationInfo)) : guest;
  const requireOrganization = !memberInfo && !unified && Boolean(chosen && ticketMemberPolicy(chosen).create_member_records);
  const issues = memberInfo ? [] : guestAttendeeIssues(attendee, { requireOrganization });
  const ready = Boolean(chosen) && issues.length === 0;
  useEffect(() => { onReadyChange?.(ready); }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = ticket => {
    if (disabled) return;
    const base = memberInfo ? memberSelfAttendee(memberInfo, organizationInfo, current) : guest;
    setCart(() => chooseFunnelTicket(ticket, base));
  };
  const update = patch => {
    if (!memberInfo) setGuest(previous => ({ ...previous, ...patch }));
    setCart(previous => updateFunnelAttendee(previous, patch));
  };

  return <div className="space-y-5" data-testid="funnel-ticket-choice">
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">Choose your ticket</legend>
      {tickets.map(ticket => {
        const id = String(ticket.id);
        const price = getEffectiveTicketPrice(ticket);
        const restricted = isRestricted(ticket);
        const soldOut = isSoldOut(ticket);
        const blocked = isReleaseBlocked(ticket);
        const unavailable = restricted || soldOut || blocked;
        const remaining = getRemaining(ticket);
        const selected = id === chosenId;
        return <label key={id} data-testid={`funnel-ticket-${id}`}
          className={`flex items-start gap-3 rounded-md border p-3 transition-colors ${selected ? 'border-indigo-400 bg-indigo-50/60' : 'border-slate-200'} ${unavailable ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-indigo-300'}`}>
          <input type="radio" name={`funnel-ticket-${eventId}`} className="mt-1 h-4 w-4 accent-indigo-600"
            checked={selected} disabled={unavailable} onChange={() => choose(ticket)} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
              {ticket.name}
              {restricted && <Badge variant="secondary" className="bg-slate-100 text-xs text-slate-600">
                <Lock className="mr-1 h-3 w-3" />{memberInfo ? 'Not available to you' : 'Members only'}</Badge>}
              {price.isEarlyBird && <Badge variant="secondary" className="border-warning/30 bg-warning/10 text-xs text-warning">Early Bird</Badge>}
              {soldOut && <Badge variant="destructive" className="text-xs">Sold Out</Badge>}
            </span>
            {blocked && <span className="mt-1 block text-xs text-slate-600" role="status">{ticketReleaseMessage(ticket)}</span>}
            {ticket.description && <span className="mt-0.5 block text-xs text-slate-500">{ticket.description}</span>}
            {showAvailability && !soldOut && remaining !== null && <span className={`mt-0.5 block text-xs ${remaining <= 5 ? 'text-warning' : 'text-slate-500'}`}>
              {remaining <= 5 ? `Only ${remaining} left` : `${remaining} available`}</span>}
            {renderTrackAccess?.(ticket)}
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-base font-semibold text-slate-900">{price.price === 0 ? 'Free' : `£${price.price.toFixed(2)}`}</span>
            {price.isEarlyBird && <span className="block text-xs text-slate-400 line-through">£{price.standardPrice.toFixed(2)}</span>}
          </span>
        </label>;
      })}
      {tickets.length === 0 && <p className="text-center text-sm text-slate-500">No tickets are currently available.</p>}
    </fieldset>

    {chosen && <fieldset className="space-y-3 border-t border-slate-200 pt-4" disabled={disabled} data-testid="funnel-attendee">
      <legend className="text-sm font-medium">Attendee</legend>
      {memberInfo ? <div className="rounded-md border border-slate-200 p-3">
        <div className="text-sm font-medium text-slate-900">{attendee.first_name} {attendee.last_name}</div>
        <div className="text-xs text-slate-500">{attendee.email}</div>
        {attendee.organization && <div className="text-xs text-slate-500">{attendee.organization}</div>}
      </div> : <>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input aria-label="First name" placeholder="First name *" value={attendee.first_name}
            onChange={e => update({ first_name: e.target.value })} onBlur={() => setTouched(true)} />
          <Input aria-label="Last name" placeholder="Last name *" value={attendee.last_name}
            onChange={e => update({ last_name: e.target.value })} onBlur={() => setTouched(true)} />
        </div>
        <Input type="email" aria-label="Email" placeholder="Email *" value={attendee.email}
          onChange={e => update({ email: e.target.value })} onBlur={() => setTouched(true)} />
        {!unified && !owned ? <RegistrationAssociationField eventId={eventId} eventKind="complex"
          placeholder={requireOrganization ? 'Organisation *' : 'Organisation (optional)'}
          value={{ organization: attendee.organization, registration_association: attendee.registration_association || null }}
          onChange={patch => update({ organization: patch.organization, registration_association: patch.registration_association || undefined })} />
          : <Input aria-label="Organisation" placeholder={requireOrganization ? 'Organisation *' : 'Organisation (optional)'}
            value={attendee.organization} onChange={e => update({ organization: e.target.value })} />}
      </>}
      <div className="space-y-1">
        <Label className="text-sm">Job title{requireJobTitle ? ' *' : ' (optional)'}</Label>
        <Input value={attendee.job_title || ''} onChange={e => update({ job_title: e.target.value })} />
        {requireJobTitle && !attendee.job_title?.trim() && <p className="text-xs text-red-600">Enter your job title.</p>}
      </div>
      <AttendeeOptionsSelector eventOptions={eventOptions} value={attendee}
        onChange={next => update(next)} idPrefix={`funnel-${eventId}`} />
      {touched && issues.length > 0 && <ul className="text-xs text-red-600" role="alert">
        {issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    </fieldset>}
    {!chosen && tickets.length > 0 && <p className="text-sm text-slate-500">Choose a ticket to continue.</p>}
    {chosen && !ready && <p className="text-sm text-slate-500">Complete your details to continue.</p>}
  </div>;
}
