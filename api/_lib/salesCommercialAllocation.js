import { SalesHttpError } from './salesAccess.js';

function allocationRpcError(error) {
  if (error?.code === '40001' || error?.code === '23505') {
    throw new SalesHttpError(409, error.message);
  }
  if (error?.code === 'P0002') throw new SalesHttpError(404, error.message);
  if (error?.code === '22023' || error?.code === '23514') {
    throw new SalesHttpError(400, error.message);
  }
  throw error;
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) allocationRpcError(error);
  return Array.isArray(data) ? data[0] : data;
}

export function confirmQuoteSale(db, tenantId, actor, quoteId, input) {
  return rpc(db, 'confirm_sales_quote_sale', {
    p_tenant_id: tenantId,
    p_quote_id: quoteId,
    p_expected_version: input.expectedVersion,
    p_idempotency_key: input.idempotencyKey,
    p_actor_kind: actor.actorType,
    p_actor_id: actor.actorId,
  });
}

export function moveAllocation(db, tenantId, actor, allocationId, kind, input) {
  const functionName = kind === 'released'
    ? 'release_sales_commercial_allocation'
    : 'cancel_sales_commercial_allocation';
  return rpc(db, functionName, {
    p_tenant_id: tenantId,
    p_allocation_id: allocationId,
    p_places: input.places,
    p_idempotency_key: input.idempotencyKey,
    p_reason: input.reason || null,
    p_actor_kind: actor.actorType,
    p_actor_id: actor.actorId,
  });
}

export function reconcileAllocationBooking(db, tenantId, actor, allocationId, input) {
  return rpc(db, 'reconcile_sales_commercial_booking', {
    p_tenant_id: tenantId,
    p_allocation_id: allocationId,
    p_booking_kind: input.bookingKind,
    p_booking_id: input.bookingId,
    p_designation: input.designation,
    p_places: input.places,
    p_idempotency_key: input.idempotencyKey,
    p_actor_kind: actor.actorType,
    p_actor_id: actor.actorId,
  });
}

export async function listAllocations(db, tenantId, filters = {}) {
  let query = db.from('sales_commercial_allocation_totals')
    .select('*')
    .eq('tenant_id', tenantId);
  if (filters.eventId) query = query.eq('event_id', filters.eventId);
  if (filters.eventKind) query = query.eq('event_reference_kind', filters.eventKind);
  if (filters.ticketTypeId) query = query.eq('ticket_type_id', filters.ticketTypeId);
  const { data, error } = await query;
  if (error) throw error;
  const totals = data || [];
  if (!totals.length) return [];
  const { data: allocations, error: allocationError } = await db
    .from('sales_commercial_allocation')
    .select('*,sales_commercial_sale(id,opportunity_id,quote_id)')
    .eq('tenant_id', tenantId)
    .in('id', totals.map((row) => row.allocation_id));
  if (allocationError) throw allocationError;
  const allocationById = new Map((allocations || []).map((row) => [row.id, row]));
  const opportunityIds = [...new Set((allocations || [])
    .map((row) => row.sales_commercial_sale?.opportunity_id).filter(Boolean))];
  const { data: opportunities, error: opportunityError } = opportunityIds.length
    ? await db.from('opportunity').select('id,organization_id').eq('tenant_id', tenantId).in('id', opportunityIds)
    : { data: [], error: null };
  if (opportunityError) throw opportunityError;
  const orgIds = [...new Set((opportunities || []).map((row) => row.organization_id).filter(Boolean))];
  const { data: organizations, error: organizationError } = orgIds.length
    ? await db.from('organization').select('id,name').eq('tenant_id', tenantId).in('id', orgIds)
    : { data: [], error: null };
  if (organizationError) throw organizationError;
  const simpleEventIds = (allocations || []).filter((row) => row.event_reference_kind === 'simple').map((row) => row.event_id);
  const complexEventIds = (allocations || []).filter((row) => row.event_reference_kind === 'complex').map((row) => row.event_id);
  const [simpleEventsResult, complexEventsResult] = await Promise.all([
    simpleEventIds.length
      ? db.from('event').select('id,title,slug,pricing_config').eq('tenant_id', tenantId).in('id', simpleEventIds)
      : Promise.resolve({ data: [], error: null }),
    complexEventIds.length
      ? db.from('complex_event').select('id,title,slug').eq('tenant_id', tenantId).in('id', complexEventIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (simpleEventsResult.error) throw simpleEventsResult.error;
  if (complexEventsResult.error) throw complexEventsResult.error;
  const complexTicketIds = (allocations || []).filter((row) => row.event_reference_kind === 'complex')
    .map((row) => row.ticket_type_id);
  const { data: complexTickets, error: complexTicketError } = complexTicketIds.length
    ? await db.from('complex_event_ticket_class').select('id,name,complex_event_id').eq('tenant_id', tenantId).in('id', complexTicketIds)
    : { data: [], error: null };
  if (complexTicketError) throw complexTicketError;
  const opportunityById = new Map((opportunities || []).map((row) => [row.id, row]));
  const organizationById = new Map((organizations || []).map((row) => [row.id, row]));
  const simpleEventById = new Map((simpleEventsResult.data || []).map((row) => [row.id, row]));
  const complexEventById = new Map((complexEventsResult.data || []).map((row) => [row.id, row]));
  const complexTicketById = new Map((complexTickets || []).map((row) => [String(row.id), row]));
  return totals.map((row) => {
    const allocation = allocationById.get(row.allocation_id);
    const opportunity = opportunityById.get(allocation?.sales_commercial_sale?.opportunity_id);
    const organization = organizationById.get(opportunity?.organization_id);
    const sourceEvent = allocation?.event_reference_kind === 'complex'
      ? complexEventById.get(allocation?.event_id)
      : simpleEventById.get(allocation?.event_id);
    const event = sourceEvent || allocation?.event_snapshot || {};
    const ticket = allocation?.ticket_snapshot || {};
    const simpleTicket = sourceEvent?.pricing_config?.ticket_classes
      ?.find((item) => String(item.id) === String(allocation?.ticket_type_id));
    const sourceTicket = allocation?.event_reference_kind === 'complex'
      ? complexTicketById.get(String(allocation?.ticket_type_id))
      : simpleTicket;
    return ({
    ...allocation,
    ...row,
    opportunity_id: opportunity?.id || allocation?.sales_commercial_sale?.opportunity_id || null,
    organization_id: organization?.id || null,
    organization_name: organization?.name || null,
    eventId: allocation?.event_id,
    eventKind: allocation?.event_reference_kind,
    eventName: event.title || event.name || event.event || null,
    eventSlug: event.slug || null,
    ticketTypeId: allocation?.ticket_type_id,
    ticketName: sourceTicket?.name || ticket.name || ticket.title || ticket.ticket || null,
    available_places: Math.max(
      0,
      Number(row.remaining || 0) - Number(row.named || 0) - Number(row.reserved || 0),
    ),
  });
  });
}

export async function listManagerAllocations(db, tenantId, memberId, filters = {}) {
  const { data: grants, error } = await db
    .from('sales_commercial_allocation_manager')
    .select('allocation_id,organization_id')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .is('revoked_at', null);
  if (error) throw error;
  const allowed = new Set((grants || []).map((grant) => grant.allocation_id));
  if (!allowed.size) return [];
  return (await listAllocations(db, tenantId, filters))
    .filter((allocation) => allowed.has(allocation.allocation_id));
}

export async function getAllocation(db, tenantId, allocationId) {
  const [
    allocationResult,
    totalsResult,
    movementResult,
    bookingResult,
    managerResult,
    invitationResult,
  ] = await Promise.all([
    db.from('sales_commercial_allocation').select('*,sales_commercial_sale(*)')
      .eq('tenant_id', tenantId).eq('id', allocationId).maybeSingle(),
    db.from('sales_commercial_allocation_totals').select('*')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId).maybeSingle(),
    db.from('sales_commercial_allocation_movement').select('*')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId)
      .order('created_at', { ascending: true }),
    db.from('sales_commercial_allocation_booking').select('*')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId)
      .order('created_at', { ascending: true }),
    db.from('sales_commercial_allocation_manager')
      .select('id,organization_id,member_id,revoked_at,created_at')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId),
    db.from('sales_commercial_allocation_invitation')
      .select('id,manager_id,organization_id,delegate_email,delegate_first_name,delegate_last_name,expires_at,claimed_at,released_at,booking_kind,booking_id,created_at')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId)
      .order('created_at', { ascending: false }),
  ]);
  if (allocationResult.error) throw allocationResult.error;
  if (!allocationResult.data) throw new SalesHttpError(404, 'Allocation not found');
  if (totalsResult.error) throw totalsResult.error;
  if (movementResult.error) throw movementResult.error;
  if (bookingResult.error) throw bookingResult.error;
  if (managerResult.error) throw managerResult.error;
  if (invitationResult.error) throw invitationResult.error;
  return {
    ...allocationResult.data,
    totals: totalsResult.data ? {
      ...totalsResult.data,
      available_places: Math.max(
        0,
        Number(totalsResult.data.remaining || 0)
          - Number(totalsResult.data.named || 0)
          - Number(totalsResult.data.reserved || 0),
      ),
    } : null,
    movements: movementResult.data || [],
    bookings: bookingResult.data || [],
    managers: managerResult.data || [],
    invitations: invitationResult.data || [],
  };
}

// Portal managers never receive the commercial audit trail, sale, snapshots,
// other managers, or invitations belonging to someone else.
export async function getManagerAllocationDetail(db, tenantId, allocationId, managerId) {
  const [allocationResult, totalsResult, grantResult, invitationResult, linksResult] = await Promise.all([
    db.from('sales_commercial_allocation').select('id,event_reference_kind,event_id,ticket_type_id')
      .eq('tenant_id', tenantId).eq('id', allocationId).maybeSingle(),
    db.from('sales_commercial_allocation_totals').select('allocated,named,reserved,released,cancelled,remaining')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId).maybeSingle(),
    db.from('sales_commercial_allocation_manager').select('organization_id')
      .eq('tenant_id', tenantId).eq('id', managerId).maybeSingle(),
    db.from('sales_commercial_allocation_invitation')
      .select('id,delegate_email,delegate_first_name,delegate_last_name,expires_at,claimed_at,released_at,booking_kind,booking_id,created_at')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId).eq('manager_id', managerId)
      .order('created_at', { ascending: false }),
    db.from('sales_commercial_allocation_booking').select('booking_kind,booking_id,designation,places,booking_snapshot')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId),
  ]);
  for (const result of [allocationResult, totalsResult, grantResult, invitationResult, linksResult]) {
    if (result.error) throw result.error;
  }
  if (!allocationResult.data || !totalsResult.data || !grantResult.data) {
    throw new SalesHttpError(404, 'Allocation not found');
  }
  const allocation = allocationResult.data;
  const [eventResult, ticketResult, orgResult] = await Promise.all([
    db.from(allocation.event_reference_kind === 'complex' ? 'complex_event' : 'event')
      .select('id,title,slug').eq('tenant_id', tenantId).eq('id', allocation.event_id).maybeSingle(),
    allocation.event_reference_kind === 'complex'
      ? db.from('complex_event_ticket_class').select('id,name').eq('tenant_id', tenantId)
        .eq('id', allocation.ticket_type_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.from('organization').select('id,name').eq('tenant_id', tenantId)
      .eq('id', grantResult.data.organization_id).maybeSingle(),
  ]);
  for (const result of [eventResult, ticketResult, orgResult]) if (result.error) throw result.error;
  let ticketName = ticketResult.data?.name || 'Ticket';
  if (allocation.event_reference_kind === 'simple') {
    const { data: pricingEvent, error } = await db.from('event').select('pricing_config')
      .eq('tenant_id', tenantId).eq('id', allocation.event_id).maybeSingle();
    if (error) throw error;
    ticketName = pricingEvent?.pricing_config?.ticket_classes
      ?.find((item) => String(item.id) === String(allocation.ticket_type_id))?.name || ticketName;
  }
  const totals = totalsResult.data;
  return {
    id: allocation.id,
    allocation_id: allocation.id,
    eventKind: allocation.event_reference_kind,
    eventId: allocation.event_id,
    eventSlug: eventResult.data?.slug || null,
    eventName: eventResult.data?.title || 'Event',
    ticketTypeId: allocation.ticket_type_id,
    ticketName,
    organizationId: orgResult.data?.id || grantResult.data.organization_id,
    organizationName: orgResult.data?.name || 'Organisation',
    totals: {
      ...totals,
      purchased: Number(totals.allocated || 0),
      registered: Number(totals.named || 0),
      available_places: Math.max(0, Number(totals.remaining || 0) - Number(totals.named || 0) - Number(totals.reserved || 0)),
    },
    bookings: (linksResult.data || []).map((link) => ({
      booking_id: link.booking_id,
      booking_kind: link.booking_kind,
      designation: link.designation,
      places: link.places,
      delegate_name: [link.booking_snapshot?.attendee_first_name, link.booking_snapshot?.attendee_last_name].filter(Boolean).join(' ') || null,
      email: link.booking_snapshot?.attendee_email || null,
    })),
    invitations: invitationResult.data || [],
  };
}

export function validateAllocationInput(input, { reconcile = false } = {}) {
  const errors = [];
  if (!Number.isInteger(input?.places) || input.places < 1) errors.push('places must be a positive integer');
  if (typeof input?.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) errors.push('idempotencyKey is required');
  if (reconcile) {
    if (Number.isInteger(input?.places) && input.places !== 1) {
      errors.push('each booking reconciliation must represent exactly one delegate place');
    }
    if (!['simple', 'complex'].includes(input?.bookingKind)) errors.push('bookingKind must be simple or complex');
    if (!['named', 'reserved'].includes(input?.designation)) errors.push('designation must be named or reserved');
    if (typeof input?.bookingId !== 'string' || !input.bookingId) errors.push('bookingId is required');
  }
  return errors;
}
