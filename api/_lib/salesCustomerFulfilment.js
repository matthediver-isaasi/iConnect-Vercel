import { createHmac, randomUUID } from 'node:crypto';
import { SalesHttpError } from './salesAccess.js';
import { hashAllocationInviteToken, deriveAllocationInviteToken, getPublicAllocationInvitationContext } from './allocationInvitation.js';
import { canonicalQuoteBaseUrl } from './salesQuoteDelivery.js';
import { sendTenantEmail } from './tenantEmailService.js';

export async function fulfilmentResult(query) {
  const { data, error } = await query;
  if (error) {
    if (error.code === 'P0002') throw new SalesHttpError(404, 'Registration link or allocation is unavailable');
    if (['23514', '22023', '23505'].includes(error.code)) throw new SalesHttpError(409, error.message);
    throw error;
  }
  return data;
}
export function customerFulfilmentToken(row) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new SalesHttpError(503, 'Registration links are not configured');
  return createHmac('sha256', secret).update(JSON.stringify(['sales-customer-fulfilment-v1', row.tenant_id, row.sale_id, row.id])).digest('base64url');
}
export async function resolveCustomerFulfilment(db, tenantId, token) {
  try {
    return await fulfilmentResult(db.rpc('resolve_sales_customer_fulfilment', {
      p_tenant: tenantId, p_hash: hashAllocationInviteToken(token),
    }));
  } catch (error) {
    if (error instanceof SalesHttpError && [400, 404].includes(error.status)) {
      throw Object.assign(new SalesHttpError(410, 'Registration link is unavailable or expired'), { code: 'invalid_token' });
    }
    throw error;
  }
}
export async function customerFulfilmentContext(db, row) {
  const allocations = await fulfilmentResult(db.from('sales_commercial_allocation')
    .select('id,event_reference_kind,event_id,ticket_type_id,event_snapshot,ticket_snapshot')
    .eq('tenant_id', row.tenant_id).eq('sale_id', row.sale_id));
  const ids = allocations.map(a => a.id);
  const totals = ids.length ? await fulfilmentResult(db.from('sales_commercial_allocation_totals')
    .select('allocation_id,allocated,named,reserved,remaining').eq('tenant_id', row.tenant_id).in('allocation_id', ids)) : [];
  return { customerName: row.customer_name, expiresAt: row.expires_at,
    allocations: await Promise.all(allocations.map(async a => {
      const t = totals.find(t => t.allocation_id === a.id);
      if (!t) throw new SalesHttpError(409, 'Allocation totals are unavailable');
      const event = await fulfilmentResult(db.from(a.event_reference_kind === 'complex' ? 'complex_event' : 'event')
        .select(a.event_reference_kind === 'complex' ? 'title' : 'title,pricing_config')
        .eq('tenant_id', row.tenant_id).eq('id', a.event_id).maybeSingle());
      const ticket = a.event_reference_kind === 'complex'
        ? await fulfilmentResult(db.from('complex_event_ticket_class').select('name')
          .eq('tenant_id', row.tenant_id).eq('complex_event_id', a.event_id).eq('id', a.ticket_type_id).maybeSingle())
        : event?.pricing_config?.ticket_classes?.find(t => String(t.id) === a.ticket_type_id);
      return { id: a.id, eventKind: a.event_reference_kind,
        eventName: event?.title || a.event_snapshot?.title || 'Event',
        ticketName: ticket?.name || a.ticket_snapshot?.name || 'Ticket',
        remaining: Math.max(0, Number(t.remaining) - Number(t.named) - Number(t.reserved)),
        registered: Number(t.named), allocated: Number(t.allocated) };
    })) };
}
export async function registerCustomerDelegate(db, row, token, input) {
  if (!/^[0-9a-f-]{36}$/i.test(input.allocationId || '')
    || typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 150
    || [input.firstName, input.lastName].some(v => typeof v !== 'string' || v.length > 200)) {
    throw new SalesHttpError(400, 'Valid allocation, delegate details and idempotency key are required');
  }
  const invitationToken = deriveAllocationInviteToken(row.tenant_id, input.allocationId,
    { actorType: 'tenant_user', actorId: row.id }, input.idempotencyKey);
  await fulfilmentResult(db.rpc('reserve_sales_customer_delegate', {
    p_tenant: row.tenant_id, p_hash: hashAllocationInviteToken(token), p_allocation: input.allocationId,
    p_invite_hash: hashAllocationInviteToken(invitationToken), p_email: input.email,
    p_first: input.firstName, p_last: input.lastName, p_key: input.idempotencyKey,
  }));
  const context = await getPublicAllocationInvitationContext(db, invitationToken);
  const tenant = await fulfilmentResult(db.from('tenant').select('domain,slug').eq('id', row.tenant_id).single());
  const path = context.eventSlug
    ? `${context.eventKind === 'complex' ? '/session-events/' : '/events/'}${encodeURIComponent(context.eventSlug)}`
    : `${context.eventKind === 'complex' ? '/ComplexEventDetail' : '/EventDetails'}?id=${encodeURIComponent(context.eventId)}`;
  return { registrationUrl: `${canonicalQuoteBaseUrl(tenant)}${path}${path.includes('?') ? '&' : '?'}allocation=${encodeURIComponent(invitationToken)}` };
}

export async function deliverCustomerFulfilment(db, row, dependencies = {}) {
  const token = customerFulfilmentToken(row);
  const lease = randomUUID();
  const claimed = await fulfilmentResult(db.rpc('claim_sales_customer_fulfilment', {
    p_id: row.id, p_hash: hashAllocationInviteToken(token), p_lease: lease,
  }));
  if (!claimed) return 'skipped';
  let outcome = 'pending';
  let sending = false;
  try {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claimed.customer_email || '')) {
      outcome = 'attention';
    } else {
      const tenant = await fulfilmentResult(db.from('tenant').select('domain,slug').eq('id', claimed.tenant_id).single());
      const url = `${canonicalQuoteBaseUrl(tenant)}/sales-ticket-registration#token=${encodeURIComponent(token)}`;
      sending = true;
      let timeout;
      const delivery = (dependencies.send || sendTenantEmail)({
        tenantId: claimed.tenant_id, to: claimed.customer_email,
        subject: 'Register your event delegates',
        text: `Your proposal has been accepted. Register delegates for your event tickets: ${url}`,
        html: `<p>Your proposal has been accepted.</p><p><a href="${url}">Register your event delegates</a></p>`,
      });
      let sent;
      try {
        sent = await Promise.race([delivery, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Delivery outcome unknown')), dependencies.timeoutMs || 10000);
        })]);
      } finally { clearTimeout(timeout); }
      outcome = sent?.success && sent.messageId ? 'sent' : sent?.ambiguousEffect === false ? 'pending' : 'attention';
    }
  } catch {
    outcome = sending ? 'attention' : 'pending';
  }
  const finished = await fulfilmentResult(db.rpc('finish_sales_customer_fulfilment', { p_id: row.id, p_lease: lease, p_outcome: outcome }));
  if (!finished) throw new SalesHttpError(409, 'Delivery lease expired; review required');
  return outcome;
}
export async function runCustomerFulfilment({ db, ...dependencies }) {
  const rows = await fulfilmentResult(db.from('sales_customer_fulfilment').select('id,tenant_id,sale_id')
    .in('status', ['pending', 'sending']).is('revoked_at', null).gt('expires_at', new Date().toISOString())
    .lte('next_attempt_at', new Date().toISOString()).order('next_attempt_at').limit(25));
  const counts = { sent: 0, pending: 0, attention: 0, skipped: 0, failed: 0 };
  const started = Date.now();
  for (const row of rows || []) {
    if (Date.now() - started > 20000) break;
    try { counts[await deliverCustomerFulfilment(db, row, dependencies)]++; }
    catch { counts.failed++; }
  }
  return counts;
}
