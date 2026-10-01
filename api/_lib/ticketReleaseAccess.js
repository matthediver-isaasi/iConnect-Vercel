import { isTicketReleased, ticketReleaseMessage } from '../../shared/ticketRelease.js';

export class TicketReleaseAccessError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.name = 'TicketReleaseAccessError';
    this.statusCode = statusCode;
  }
}

// Only pass allocationContext returned by resolveAllocationInvitation, never
// request data. The exemption applies to its one purchased ticket, not the cart.
export function assertRequestedTicketsReleased({
  event, tickets, ticketIds, allocationContext = null, eventKind = 'simple',
}) {
  if (!event?.id || !Array.isArray(tickets) || !Array.isArray(ticketIds) || !ticketIds.length) {
    throw new TicketReleaseAccessError('Unable to verify ticket availability', 503);
  }
  const now = Date.now();
  return ticketIds.map((id) => {
    const missing = id === null || id === undefined || id === '';
    if (!tickets.length && missing) return null; // Legacy single-price/free event.
    const ticket = !missing && tickets.find((row) => row.id != null && String(row.id) === String(id));
    if (!ticket) {
      throw new TicketReleaseAccessError(
        missing ? 'A valid ticket class is required' : `Invalid ticket class: ${id}`, 400,
      );
    }
    const purchased = allocationContext
      && allocationContext.tenantId === event.tenant_id
      && allocationContext.eventKind === eventKind
      && String(allocationContext.eventId) === String(event.id)
      && String(allocationContext.ticketTypeId) === String(ticket.id);
    if (!purchased && !isTicketReleased(ticket, now)) {
      throw new TicketReleaseAccessError(ticketReleaseMessage(ticket) || 'This ticket is not yet available');
    }
    return ticket;
  });
}

function simpleTicketClasses(event) {
  let config = event.pricing_config;
  if (config === '') config = null; // Existing empty-string legacy pricing.
  if (typeof config === 'string') {
    try { config = JSON.parse(config); }
    catch { throw new TicketReleaseAccessError('Unable to verify ticket availability', 503); }
  }
  if (config?.ticket_classes != null && !Array.isArray(config.ticket_classes)) {
    throw new TicketReleaseAccessError('Unable to verify ticket availability', 503);
  }
  return config?.ticket_classes || [];
}

// EventDetails synthesizes this UI-only ID for legacy simple pricing. Never
// persist it as a ticket class or pass it into the configured-ticket capacity RPC.
export function normalizeSimpleTicketId(event, ticketId) {
  return ticketId === 'default' && simpleTicketClasses(event).length === 0 ? null : ticketId;
}

export function assertSimpleTicketsReleased(event, ticketIds, allocationContext = null) {
  const tickets = simpleTicketClasses(event);
  return assertRequestedTicketsReleased({
    event, tickets,
    ticketIds: ticketIds.map(id => id === 'default' && tickets.length === 0 ? null : id),
    allocationContext,
  });
}

export async function loadComplexReleaseTickets(client, event) {
  const { data, error } = await client.from('complex_event_ticket_class')
    .select('*').eq('complex_event_id', event.id).eq('tenant_id', event.tenant_id);
  if (error || !Array.isArray(data)) {
    throw new TicketReleaseAccessError('Unable to verify ticket availability', 503);
  }
  return data;
}