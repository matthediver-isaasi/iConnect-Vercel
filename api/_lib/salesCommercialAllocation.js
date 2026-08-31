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
    .select('*')
    .eq('tenant_id', tenantId)
    .in('id', totals.map((row) => row.allocation_id));
  if (allocationError) throw allocationError;
  const allocationById = new Map((allocations || []).map((row) => [row.id, row]));
  return totals.map((row) => ({ ...allocationById.get(row.allocation_id), ...row }));
}

export async function getAllocation(db, tenantId, allocationId) {
  const [allocationResult, movementResult, bookingResult] = await Promise.all([
    db.from('sales_commercial_allocation').select('*,sales_commercial_sale(*)')
      .eq('tenant_id', tenantId).eq('id', allocationId).maybeSingle(),
    db.from('sales_commercial_allocation_movement').select('*')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId)
      .order('created_at', { ascending: true }),
    db.from('sales_commercial_allocation_booking').select('*')
      .eq('tenant_id', tenantId).eq('allocation_id', allocationId)
      .order('created_at', { ascending: true }),
  ]);
  if (allocationResult.error) throw allocationResult.error;
  if (!allocationResult.data) throw new SalesHttpError(404, 'Allocation not found');
  if (movementResult.error) throw movementResult.error;
  if (bookingResult.error) throw bookingResult.error;
  return {
    ...allocationResult.data,
    movements: movementResult.data || [],
    bookings: bookingResult.data || [],
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
