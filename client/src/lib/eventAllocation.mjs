export function normalizeAllocationContext(payload) {
  const root = payload?.allocation || payload?.data || payload || {};
  const source = root?.totals ? { ...root, ...root.totals } : root;
  const event = source.event || source.event_snapshot || {};
  const ticket = source.ticket_class || source.ticket || source.ticket_snapshot || {};
  const organization = source.organization || source.organisation || source.sales_commercial_sale?.organization || {};
  const eventKind = source.eventKind || source.event_kind || source.event_reference_kind || event.kind || 'simple';
  const bookings = Array.isArray(source.bookings) ? source.bookings : [];
  const movements = Array.isArray(source.movements) ? source.movements : [];
  const movementPlaces = (kinds) => movements
    .filter((item) => kinds.includes(item.movement_kind))
    .reduce((sum, item) => sum + Number(item.places || 0), 0);
  const registered = Number(source.registered ?? source.named ?? source.consumed
    ?? bookings.filter((item) => item.designation === 'named' && item.status !== 'cancelled').reduce((sum, item) => sum + Number(item.places || 1), 0));
  const reserved = Number(source.reserved
    ?? bookings.filter((item) => item.designation === 'reserved' && item.status !== 'cancelled').reduce((sum, item) => sum + Number(item.places || 1), 0));
  const purchased = Number(source.purchased ?? source.allocated ?? source.allocated_places ?? 0);
  const released = Number(source.released ?? movementPlaces(['released', 'cancelled']));
  return {
    id: source.id || source.allocation_id || null,
    token: source.context_token || source.allocation_token || source.token || null,
    eventKind,
    eventId: source.eventId || source.event_id || event.id || null,
    eventSlug: source.eventSlug || source.event_slug || event.slug || null,
    eventName: source.eventName || source.event_name || event.title || event.name || event.event || 'Event',
    ticketTypeId: String(source.ticketTypeId || source.ticket_type_id || source.ticket_class_id || ticket.id || ''),
    ticketName: source.ticketName || source.ticket_name || ticket.name || ticket.title || ticket.ticket || 'Ticket',
    organizationId: source.organizationId || source.organization_id || source.organisation_id || organization.id || null,
    organizationName: source.organizationName || source.organization_name || source.organisation_name || organization.name || 'Organisation',
    delegateEmail: source.delegateEmail || source.delegate_email || '',
    delegateFirstName: source.delegateFirstName || source.delegate_first_name || '',
    delegateLastName: source.delegateLastName || source.delegate_last_name || '',
    purchased,
    registered,
    reserved,
    released,
    remaining: Number(source.remaining ?? Math.max(0, purchased - released)),
    invitations: Array.isArray(source.invitations) ? source.invitations : [],
    bookings,
    status: source.status || 'active',
  };
}

export function allocationRegistrationUrl(context, token) {
  const normalized = normalizeAllocationContext(context);
  const identifier = token || normalized.token;
  if (!identifier) return null;
  if (normalized.eventSlug) {
    const base = normalized.eventKind === 'complex' ? '/session-events/' : '/events/';
    return `${base}${encodeURIComponent(normalized.eventSlug)}?allocation=${encodeURIComponent(identifier)}`;
  }
  if (!normalized.eventId) return null;
  const base = normalized.eventKind === 'complex' ? '/ComplexEventDetail' : '/EventDetails';
  return `${base}?id=${encodeURIComponent(normalized.eventId)}&allocation=${encodeURIComponent(identifier)}`;
}

export function allocationPlacesAvailable(context) {
  const allocation = normalizeAllocationContext(context);
  return Math.max(0, allocation.remaining - allocation.registered - allocation.reserved);
}

export function allocationCartUnitPrice(ticketTypeId, ordinaryPrice, context) {
  return context?.ticketTypeId
    && String(ticketTypeId) === String(context.ticketTypeId)
    ? 0
    : Number(ordinaryPrice || 0);
}