import { isPrivateTicket, isPrivateTicketEligible, serializeTicketAudience } from './ticketAudience.js';
import { ticketOrganizationTypeAllowed } from './ticketOrganizationType.js';

export function projectTicketOrganizationType(ticket, viewer, tenantId) {
  return { ...ticket, ...(ticket.organization_type_enabled ? {
    organization_type_eligible: ticketOrganizationTypeAllowed(ticket, viewer, tenantId),
  } : {}) };
}

export function filterViewerTickets(tickets, viewer, tenantId) {
  if (!Array.isArray(tickets)) throw new Error('Unable to verify ticket audience');
  return tickets
    .filter(ticket => (!ticket.audience_mode || ticket.audience_mode === 'legacy')
      || (isPrivateTicket(ticket) && isPrivateTicketEligible(ticket, viewer, tenantId)))
    .map(ticket => projectTicketOrganizationType(serializeTicketAudience(ticket, isPrivateTicket(ticket)), viewer, tenantId));
}

export function projectSimpleTicketAudience(event, viewer, tenantId) {
  let config = event.pricing_config;
  if (typeof config === 'string' && config) {
    try { config = JSON.parse(config); }
    catch { throw new Error('Unable to verify ticket audience'); }
  }
  if (!config || typeof config !== 'object') return event;
  const tickets = filterViewerTickets(config.ticket_classes || [], viewer, tenantId);
  const safeConfig = { ...config };
  if ((config.ticket_classes || []).length) delete safeConfig.ticket_price;
  return { ...event, pricing_config: {
    ...safeConfig, ticket_classes: tickets,
    ticket_classes_configured: (config.ticket_classes || []).length > 0,
  } };
}
