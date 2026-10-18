// Private tickets must never be inferred eligible from client-held membership
// lists. The read API supplies this redacted, viewer-specific decision.
export function privateTicketVisible(ticket, member) {
  return ticket?.audience_mode !== 'selected_members'
    || (!!member && ticket.private_ticket_eligible === true);
}

export function mergeAllocationTicket(tickets, payload, context) {
  const ticket = payload?.ticket_class;
  if (!context?.ticketTypeId || ticket?.allocation_ticket_eligible !== true || String(ticket.id) !== String(context.ticketTypeId)) return tickets;
  return [...tickets.filter(item => String(item.id) !== String(ticket.id)), ticket];
}

export function reconcilePrivateCart(cart, tickets, member, allocationContext = null) {
  const byId = new Map(tickets.map(ticket => [String(ticket.id), ticket]));
  let changed = false;
  const next = {};
  for (const [id, entry] of Object.entries(cart)) {
    const original = entry.ticketClass || entry.ticket || entry;
    const current = byId.get(String(id));
    if ((original.audience_mode === 'selected_members' || current?.audience_mode === 'selected_members')
      && (!current || (!privateTicketVisible(current, member) && !(current.allocation_ticket_eligible === true && String(current.id) === String(allocationContext?.ticketTypeId))))) {
      changed = true;
    } else next[id] = entry;
  }
  return changed ? next : cart;
}
