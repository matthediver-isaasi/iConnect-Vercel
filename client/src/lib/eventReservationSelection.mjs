// Keep every attendee field (including custom answers); purchaser is always
// captured explicitly by the shared payment surface, never selected by index.
export const isGuestOwnedReservation = snapshot => Boolean(snapshot?.session && snapshot.session.member_id == null);

export function savedReservationAcceptance(saved, bookingTerms, conductContent) {
  return {
    terms: saved?.terms_accepted === true && typeof saved.terms_content === 'string' && saved.terms_content === bookingTerms,
    conduct: saved?.code_of_conduct_accepted === true && typeof saved.code_of_conduct_content === 'string'
      && saved.code_of_conduct_content === conductContent,
  };
}

// A projection may exclude this reservation's own stock. Only server-verified,
// still-held quantities can exempt an unchanged/reduced selection from that
// projection. The journey frame separately latches expiry using its own clock;
// mutations still go to the atomic server command, never a local stock write.
export function heldReservationQuantity(snapshot, nodeId, ticketId) {
  if (snapshot?.session?.state !== 'held' || !nodeId || ticketId == null) return 0;
  const serverNow = Date.parse(snapshot.serverNow), expires = Date.parse(snapshot.session.expires_at);
  if (!Number.isFinite(serverNow) || !Number.isFinite(expires) || expires <= serverNow) return 0;
  return (snapshot.holds || []).reduce((sum, hold) => {
    if (hold.node_id !== nodeId || String(hold.ticket_id) !== String(ticketId)) return sum;
    if (['released', 'expired', 'cancelled', 'confirmed'].includes(hold.state || hold.status)) return sum;
    if (hold.expires_at && !(Date.parse(hold.expires_at) > serverNow)) return sum;
    return sum + (Number.isSafeInteger(Number(hold.quantity)) && Number(hold.quantity) > 0 ? Number(hold.quantity) : 0);
  }, 0);
}

export function reservationSelection({ items, purchaser, termsAccepted, bookingTerms, conduct, thirdPartyConsent }) {
  const selected = items.filter(item => item.attendees?.length);
  const attendeesByTicket = Object.fromEntries(selected.map(item => [String(item.id), item.attendees]));
  return {
    tickets: selected.map(item => ({ id: String(item.id), quantity: item.attendees.length })),
    answers: {
      purchaser: { ...purchaser },
      attendeesByTicket,
      ...(selected.length === 1 ? { attendees: selected[0].attendees } : {}),
      terms_accepted: termsAccepted === true,
      terms_content: bookingTerms || '',
      code_of_conduct_accepted: conduct.accepted === true,
      code_of_conduct_content: conduct.content || '',
      ...(typeof thirdPartyConsent === 'boolean' ? { third_party_consent: thirdPartyConsent } : {}),
    },
  };
}

export function restoreReservationCart(offer) {
  const answers = offer?.draft?.answers || {};
  const selected = offer?.selectedTickets || offer?.draft?.tickets || [];
  return Object.fromEntries(selected.map(selection => {
    const id = String(selection.id ?? selection.ticketId ?? selection.ticket_id);
    const attendees = answers.attendeesByTicket?.[id] || (selected.length === 1 ? answers.attendees : []) || [];
    return [id, { ticketClass: offer.tickets.find(ticket => String(ticket.id) === id),
      attendees: Array.from({ length: Number(selection.quantity) || attendees.length }, (_, index) => ({
        ...attendees[index], isValid: attendees[index]?.isValid !== false,
      })) }];
  }).filter(([, item]) => item.ticketClass));
}
