import { getSession } from './session.js';
import { hasAdminAccess } from './tenantContext.js';
import { isPrivateTicket, isPrivateTicketEligible } from '../../shared/ticketAudience.js';

export class PrivateTicketAccessError extends Error {
  constructor(message = 'You do not have access to this ticket class', statusCode = 403) {
    super(message);
    this.name = 'PrivateTicketAccessError';
    this.statusCode = statusCode;
  }
}

export async function loadPrivateTicketViewer(req, tenantId, db) {
  if (!req || !tenantId) return null;
  const session = await getSession(req);
  const memberId = session?.data?.memberId;
  if (!memberId || !tenantId) return null;
  const { data: member, error } = await db.from('member')
    .select('id,tenant_id,login_enabled,membership_paused,email')
    .eq('id', memberId).maybeSingle();
  if (error) throw new PrivateTicketAccessError('Unable to verify ticket eligibility', 503);
  if (!member || member.login_enabled === false || member.membership_paused === true
    || (member.email?.startsWith('deleted_') && member.email?.endsWith('@deleted.local'))) return null;
  const ownerTenantId = member.tenant_id;
  return ownerTenantId === tenantId ? { memberId: member.id, tenantId: ownerTenantId } : null;
}

// allocationContext must ONLY come from resolveAllocationInvitation, never from
// a request body. Its purchased entitlement is limited to its exact ticket.
export async function assertPrivateTicketsAccessible({
  req, db, event, tickets, ticketIds, eventKind = 'simple', allocationContext = null,
}) {
  if (!event?.id || !event?.tenant_id || !Array.isArray(tickets)
    || !Array.isArray(ticketIds) || !ticketIds.length) {
    throw new PrivateTicketAccessError('Unable to verify ticket eligibility', 503);
  }
  let viewer;
  const selected = [];
  for (const id of ticketIds) {
    if (!tickets.length && (id == null || id === '' || id === 'default')) {
      selected.push(null);
      continue;
    }
    const ticket = tickets.find(row => row.id != null && String(row.id) === String(id));
    if (!ticket) throw new PrivateTicketAccessError('A valid ticket class is required', 400);
    if (ticket.audience_mode && !['legacy', 'selected_members'].includes(ticket.audience_mode)) {
      throw new PrivateTicketAccessError();
    }
    if (isPrivateTicket(ticket)) {
      const purchased = allocationContext
        && allocationContext.tenantId === event.tenant_id
        && allocationContext.eventKind === eventKind
        && String(allocationContext.eventId) === String(event.id)
        && String(allocationContext.ticketTypeId) === String(ticket.id);
      if (!purchased) {
        if (viewer === undefined) viewer = await loadPrivateTicketViewer(req, event.tenant_id, db);
        if (!isPrivateTicketEligible(ticket, viewer, event.tenant_id)) throw new PrivateTicketAccessError();
      }
    }
    selected.push(ticket);
  }
  return selected;
}

export async function assertSimplePrivateTicketsAccessible({ event, ...options }) {
  let config = event.pricing_config;
  if (typeof config === 'string' && config !== '') {
    try { config = JSON.parse(config); }
    catch { throw new PrivateTicketAccessError('Unable to verify ticket eligibility', 503); }
  }
  if (config?.ticket_classes != null && !Array.isArray(config.ticket_classes)) {
    throw new PrivateTicketAccessError('Unable to verify ticket eligibility', 503);
  }
  return assertPrivateTicketsAccessible({ ...options, event, tickets: config?.ticket_classes || [] });
}

// Call for generic Booking / ComplexEventBooking inserts and event/ticket
// reassignments. For PATCH pass the server-loaded existing row so omitted
// references cannot bypass the target check. Admin imports/overrides retain
// their existing policy; ordinary requests must satisfy the checkout audience.
export async function assertGenericPrivateTicketBooking({
  req, db, tenantCtx, entity, body, existing = null,
}) {
  const normalized = String(entity || '').replace(/[-_]/g, '').toLowerCase();
  if (!['booking', 'complexeventbooking'].includes(normalized)) return;
  if (tenantCtx?.isAuthenticated && await hasAdminAccess(tenantCtx)) return;
  const target = { ...(existing || {}), ...(body || {}) };
  const tenantId = tenantCtx?.effectiveTenantId || tenantCtx?.tenantId;
  if (!tenantId || !target.event_id || (target.tenant_id && target.tenant_id !== tenantId)) {
    throw new PrivateTicketAccessError('Unable to verify booking ticket audience', 400);
  }
  const complex = normalized === 'complexeventbooking';
  const { data: event, error } = await db.from(complex ? 'complex_event' : 'event')
    .select(complex ? 'id,tenant_id' : 'id,tenant_id,pricing_config').eq('id', target.event_id).eq('tenant_id', tenantId).maybeSingle();
  if (error || !event) throw new PrivateTicketAccessError('Unable to verify booking ticket audience', error ? 503 : 404);
  if (!complex) {
    return assertSimplePrivateTicketsAccessible({
      req, db, event, ticketIds: [target.ticket_class_id],
    });
  }
  const result = await db.from('complex_event_ticket_class').select('*')
    .eq('complex_event_id', event.id).eq('tenant_id', tenantId);
  if (result.error || !Array.isArray(result.data)) {
    throw new PrivateTicketAccessError('Unable to verify booking ticket audience', 503);
  }
  return assertPrivateTicketsAccessible({
    req, db, event, tickets: result.data, ticketIds: [target.ticket_class_id], eventKind: 'complex',
  });
}
