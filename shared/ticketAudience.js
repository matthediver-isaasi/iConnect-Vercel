// Audience policy is independent of legacy visibility, roles and groups.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPrivateTicket(ticket) {
  return ticket?.audience_mode === 'selected_members';
}

export function isPrivateTicketEligible(ticket, viewer, ticketTenantId) {
  if (!isPrivateTicket(ticket)) return false;
  const memberId = viewer?.memberId;
  return typeof memberId === 'string' && UUID.test(memberId)
    && !!ticketTenantId && viewer?.tenantId === ticketTenantId
    && (!ticket.tenant_id || ticket.tenant_id === ticketTenantId)
    && Array.isArray(ticket.selected_member_ids)
    && ticket.selected_member_ids.every(id => typeof id === 'string' && UUID.test(id))
    && ticket.selected_member_ids.includes(memberId);
}

export function serializeTicketAudience(ticket, eligible = false) {
  const { selected_member_ids, private_ticket_eligible, ...safe } = ticket || {};
  return {
    ...safe,
    audience_mode: ticket?.audience_mode || 'legacy',
    ...(isPrivateTicket(ticket) && eligible === true ? { private_ticket_eligible: true } : {}),
  };
}
