import crypto from 'node:crypto';
import { SalesHttpError } from './salesAccess.js';

export function hashAllocationInviteToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
    throw new SalesHttpError(400, 'Invalid allocation invitation token');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return Array.isArray(data) ? data[0] : data;
  if (error.code === 'P0002') throw new SalesHttpError(404, error.message);
  if (error.code === '42501') throw new SalesHttpError(403, error.message);
  if (['22023', '23514'].includes(error.code)) throw new SalesHttpError(409, error.message);
  if (error.code === '23505') throw new SalesHttpError(409, 'Invitation already exists or has been used');
  throw error;
}

export function createAllocationInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function deriveAllocationInviteToken(tenantId, allocationId, actor, idempotencyKey) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new SalesHttpError(503, 'Invitation token signing is not configured');
  }
  const binding = JSON.stringify([
    'sales-allocation-invite-v1', tenantId, allocationId,
    actor.actorType, actor.actorId, idempotencyKey,
  ]);
  return crypto.createHmac('sha256', secret).update(binding).digest('base64url');
}

export function resolveAllocationInvitation(db, token) {
  return rpc(db, 'resolve_sales_allocation_invitation', {
    p_token_hash: hashAllocationInviteToken(token),
  });
}

// Deliberately returns only the registration contract, never commercial sale
// fields, movements, manager identities, or the stored token hash.
export async function getPublicAllocationInvitationContext(db, token) {
  const context = await resolveAllocationInvitation(db, token);
  const [totalsResult, orgResult, eventResult, ticketResult] = await Promise.all([
    db.from('sales_commercial_allocation_totals').select('allocated,named,reserved,released,cancelled,remaining')
      .eq('tenant_id', context.tenantId).eq('allocation_id', context.allocationId).maybeSingle(),
    db.from('organization').select('id,name').eq('tenant_id', context.tenantId)
      .eq('id', context.organizationId).maybeSingle(),
    db.from(context.eventKind === 'complex' ? 'complex_event' : 'event').select('id,slug,title')
      .eq('tenant_id', context.tenantId).eq('id', context.eventId).maybeSingle(),
    context.eventKind === 'complex'
      ? db.from('complex_event_ticket_class').select('id,name').eq('tenant_id', context.tenantId)
        .eq('complex_event_id', context.eventId).eq('id', context.ticketTypeId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  for (const result of [totalsResult, orgResult, eventResult, ticketResult]) {
    if (result.error) throw result.error;
  }
  if (!totalsResult.data || !orgResult.data || !eventResult.data) {
    throw new SalesHttpError(404, 'Allocation invitation context is unavailable');
  }
  let ticketName = ticketResult.data?.name || null;
  if (context.eventKind === 'simple') {
    const classes = eventResult.data.pricing_config?.ticket_classes;
    // The context endpoint's event select intentionally avoids pricing config
    // in normal responses; fetch it only for the fixed ticket display name.
    const { data: eventPricing, error } = await db.from('event').select('pricing_config')
      .eq('tenant_id', context.tenantId).eq('id', context.eventId).maybeSingle();
    if (error) throw error;
    ticketName = Array.isArray(eventPricing?.pricing_config?.ticket_classes)
      ? eventPricing.pricing_config.ticket_classes.find((item) => String(item.id) === String(context.ticketTypeId))?.name
      : null;
  }
  const totals = totalsResult.data;
  return {
    tenantId: context.tenantId,
    id: context.allocationId,
    allocation_id: context.allocationId,
    eventKind: context.eventKind,
    eventId: context.eventId,
    eventSlug: eventResult.data.slug || null,
    eventName: eventResult.data.title || 'Event',
    ticketTypeId: context.ticketTypeId,
    ticketName: ticketName || 'Ticket',
    organizationId: orgResult.data.id,
    organizationName: orgResult.data.name || 'Organisation',
    delegateEmail: context.delegateEmail,
    delegateFirstName: context.delegateFirstName || '',
    delegateLastName: context.delegateLastName || '',
    expiresAt: context.expiresAt,
    totals: {
      ...totals,
      purchased: Number(totals.allocated || 0),
      registered: Number(totals.named || 0),
      available_places: Math.max(0, Number(totals.remaining || 0) - Number(totals.named || 0) - Number(totals.reserved || 0)),
    },
  };
}

export function claimAllocationInvitation(db, token, bookingKind, bookingId) {
  return rpc(db, 'claim_sales_allocation_invitation', {
    p_token_hash: hashAllocationInviteToken(token),
    p_booking_kind: bookingKind,
    p_booking_id: bookingId,
  });
}

export async function reserveAllocationInvitation(db, tenantId, allocationId, actor, input) {
  const token = deriveAllocationInviteToken(
    tenantId, allocationId, actor, input.idempotencyKey,
  );
  const result = await rpc(db, 'reserve_sales_allocation_invitation', {
    p_tenant_id: tenantId,
    p_allocation_id: allocationId,
    p_token_hash: hashAllocationInviteToken(token),
    p_delegate_email: String(input.email || '').trim().toLowerCase(),
    p_delegate_first_name: input.firstName || null,
    p_delegate_last_name: input.lastName || null,
    p_expires_at: input.expiresAt,
    p_idempotency_key: input.idempotencyKey,
    p_actor_kind: actor.actorType,
    p_actor_id: actor.actorId,
  });
  return { ...result, token };
}

export function releaseAllocationInvitation(db, tenantId, invitationId, actor) {
  return rpc(db, 'release_sales_allocation_invitation', {
    p_tenant_id: tenantId,
    p_invitation_id: invitationId,
    p_actor_kind: actor.actorType,
    p_actor_id: actor.actorId,
  });
}

export function grantAllocationManager(db, tenantId, allocationId, actor, input) {
  if (actor.actorType !== 'tenant_user') {
    throw new SalesHttpError(403, 'Only tenant administrators can grant allocation access');
  }
  return rpc(db, 'grant_sales_allocation_manager', {
    p_tenant_id: tenantId,
    p_allocation_id: allocationId,
    p_organization_id: input.organizationId,
    p_member_id: input.memberId,
    p_idempotency_key: input.idempotencyKey,
    p_actor_kind: actor.actorType,
    p_actor_id: actor.actorId,
  });
}

export async function requireAllocationManager(db, tenantId, allocationId, memberId) {
  const { data, error } = await db
    .from('sales_commercial_allocation_manager')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('allocation_id', allocationId)
    .eq('member_id', memberId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new SalesHttpError(404, 'Allocation not found');
  return data;
}