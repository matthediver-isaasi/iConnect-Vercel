import { createHmac, randomUUID } from 'node:crypto';
import { SalesHttpError } from './salesAccess.js';
import { hashAllocationInviteToken, deriveAllocationInviteToken, getPublicAllocationInvitationContext } from './allocationInvitation.js';
import { canonicalQuoteBaseUrl } from './salesQuoteDelivery.js';
import { sendTenantEmail } from './tenantEmailService.js';
import { checkSalesAutomaticDelivery } from './salesCommunicationPolicy.js';
import { purchaserAllocationAuthority, purchaserRegistrationSettings } from './salesPurchaserRoster.js';
import { ticketRegistrationDeadline } from '../../shared/ticketRelease.js';

export async function fulfilmentResult(query) {
  const { data, error } = await query;
  if (error) {
    if (error.code === 'P0002') throw new SalesHttpError(404, 'Registration link or allocation is unavailable');
    if (['23514', '22023', '23505', 'PT409', '40001', '40P01'].includes(error.code)) throw new SalesHttpError(409, error.message);
    throw error;
  }
  return data;
}
export function customerFulfilmentToken(row) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new SalesHttpError(503, 'Registration links are not configured');
  const identity = ['sales-customer-fulfilment-v1', row.tenant_id, row.sale_id, row.id];
  if (row.token_generation > 0) identity.push(row.token_generation);
  return createHmac('sha256', secret).update(JSON.stringify(identity)).digest('base64url');
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
  const settings = await purchaserRegistrationSettings(db, row.tenant_id);
  const tenant = await fulfilmentResult(db.from('tenant').select('name,header_logo_url,logo_url,primary_color')
    .eq('id', row.tenant_id).maybeSingle());
  const allocations = await fulfilmentResult(db.from('sales_commercial_allocation')
    .select('id,event_reference_kind,event_id,ticket_type_id,event_snapshot,ticket_snapshot')
    .eq('tenant_id', row.tenant_id).eq('sale_id', row.sale_id));
  const ids = allocations.map(a => a.id);
  const totals = ids.length ? await fulfilmentResult(db.from('sales_commercial_allocation_totals')
    .select('allocation_id,allocated,named,reserved,remaining').eq('tenant_id', row.tenant_id).in('allocation_id', ids)) : [];
  const slots = [];
  for (let offset = 0; ; offset += 200) {
    const page = await fulfilmentResult(db.from('sales_purchaser_slot')
      .select('id,allocation_id,version,details,booking_id').eq('tenant_id', row.tenant_id)
      .eq('fulfilment_id', row.id).order('id').range(offset, offset + 199));
    slots.push(...page);
    if (page.length < 200) break;
    if (offset >= 9800) throw new SalesHttpError(413, 'This roster is too large. Please contact the organiser.');
  }
  return { customerName: row.customer_name, expiresAt: row.expires_at, settings, serverNow: new Date().toISOString(),
    branding: { name: tenant?.name || null, logoUrl: tenant?.header_logo_url || tenant?.logo_url || null,
      primaryColor: tenant?.primary_color || null },
    allocations: await Promise.all(allocations.map(async a => {
      const t = totals.find(t => t.allocation_id === a.id);
      const allocationSlots = slots.filter(slot => slot.allocation_id === a.id);
      if (!t) throw new SalesHttpError(409, 'Allocation totals are unavailable');
      let event, ticket, unavailable = false;
      try { ({ event, ticket } = await purchaserAllocationAuthority(db, row, a.id)); }
      catch (error) {
        if (!(error instanceof SalesHttpError) || error.status !== 409
          || !/^The purchased (event|ticket type) is unavailable$/.test(error.message)) throw error;
        event = a.event_snapshot || {}; ticket = a.ticket_snapshot || {}; unavailable = true;
      }
      return { id: a.id, eventKind: a.event_reference_kind,
        requiresSelfRegistration: Boolean(event.member_group_id),
        eventName: event?.title || a.event_snapshot?.title || 'Event',
        ticketName: ticket?.name || a.ticket_snapshot?.name || 'Ticket',
        remaining: Math.max(0, Number(t.remaining) - Number(t.named)),
        availableToAdd: Math.max(0, Number(t.remaining) - Number(t.named) - Number(t.reserved)
          - allocationSlots.filter(slot => !slot.booking_id).length),
        registered: Number(t.named), allocated: Number(t.allocated),
        ...ticketRegistrationDeadline(event, ticket),
        ...(unavailable ? { closed: true, availableToAdd: 0,
          reason: 'This event or ticket is no longer available. Contact the organiser; purchased places have not been released.' } : {}),
        timezone: ticket.close_timezone || event.timezone || 'UTC',
        options: settings.collectOptions ? { dietary_options: event.dietary_options || [],
          allergy_options: event.allergy_options || [], accessibility_options: event.accessibility_options || [] } : {},
        slots: allocationSlots.map(({ allocation_id, booking_id, ...slot }) => ({
          ...slot, status: booking_id ? 'registered' : 'draft',
        })) };
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

export async function customerDeadlineLines(db, row) {
  const allocations = await fulfilmentResult(db.from('sales_commercial_allocation')
    .select('id').eq('tenant_id', row.tenant_id).eq('sale_id', row.sale_id));
  return Promise.all(allocations.map(async allocation => {
    const { event, ticket } = await purchaserAllocationAuthority(db, row, allocation.id);
    const deadline = ticketRegistrationDeadline(event, ticket);
    const name = `${event.title || 'Event'} — ${ticket.name || 'Ticket'}`;
    if (deadline.closed) return `${name}: registration is closed; contact the organiser.`;
    if (!deadline.closesAt) return `${name}: no registration deadline is currently set.`;
    const zone = ticket.close_timezone || event.timezone || 'UTC';
    return `${name}: register or amend by ${new Date(deadline.closesAt).toLocaleString('en-GB', {
      timeZone: zone, dateStyle: 'full', timeStyle: 'long',
    })} (${zone}).`;
  }));
}

export async function deliverCustomerFulfilment(db, row, dependencies = {}) {
  const token = customerFulfilmentToken(row);
  const lease = randomUUID();
  const claimed = await fulfilmentResult(db.rpc('claim_sales_customer_fulfilment', {
    p_id: row.id, p_hash: hashAllocationInviteToken(token), p_lease: lease, p_generation: row.token_generation || 0,
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
      const policy = await checkSalesAutomaticDelivery(db, {
        tenantId: claimed.tenant_id, category: 'customer_fulfilment', id: row.id, claim: lease,
      });
      if (policy === 'suppressed') return 'suppressed';
      const deadlineLines = await (dependencies.loadDeadlines || customerDeadlineLines)(db, claimed);
      const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const deadlineHtml = deadlineLines.length ? `<ul>${deadlineLines.map(line => `<li>${escape(line)}</li>`).join('')}</ul>` : '';
      // Deadline discovery can yield; honour a policy edit made while preparing the email.
      if (await checkSalesAutomaticDelivery(db, {
        tenantId: claimed.tenant_id, category: 'customer_fulfilment', id: row.id, claim: lease,
      }) === 'suppressed') return 'suppressed';
      sending = true;
      let timeout;
      const delivery = (dependencies.send || sendTenantEmail)({
        tenantId: claimed.tenant_id, to: claimed.customer_email,
        subject: 'Manage your event registrations',
        text: `Your proposal has been accepted. Complete attendee details, save progress and return to amend registrations before each ticket's registration deadline. Purchased places are not automatically released at closure.\n${deadlineLines.join('\n')}\nManage registrations: ${url}`,
        html: `<p>Your proposal has been accepted.</p><p>Complete attendee details, save progress and return to amend registrations before each ticket’s registration deadline. Each event’s current deadline is shown on your secure page. Purchased places are not automatically released at closure.</p>${deadlineHtml}<p><a href="${url}">Manage your event registrations</a></p>`,
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
  const rows = await fulfilmentResult(db.from('sales_customer_fulfilment').select('id,tenant_id,sale_id,token_generation')
    .in('status', ['pending', 'sending']).is('revoked_at', null).gt('expires_at', new Date().toISOString())
    .lte('next_attempt_at', new Date().toISOString()).order('next_attempt_at').limit(25));
  const counts = { sent: 0, suppressed: 0, pending: 0, attention: 0, skipped: 0, failed: 0 };
  const started = Date.now();
  for (const row of rows || []) {
    if (Date.now() - started > 20000) break;
    try { counts[await deliverCustomerFulfilment(db, row, dependencies)]++; }
    catch { counts.failed++; }
  }
  return counts;
}
