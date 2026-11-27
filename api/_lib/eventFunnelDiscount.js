import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
import { funnelLineTotal } from './eventFunnelCommercial.js';
import { allocateFunnelAmounts } from './eventFunnelRegistrationPlan.js';

const unavailable = () => { throw new FunnelJourneyError('Discount codes could not be checked. Try again shortly.', 'DISCOUNT_UNAVAILABLE', 503); };
const invalid = reason => { throw new FunnelJourneyError(reason, 'DISCOUNT_INVALID', 409); };
// ILIKE is used for case-insensitive matching (as in normal checkout), so a
// typed % or _ must never match other codes.
const literal = value => value.replace(/[\\%_]/g, match => `\\${match}`);

export function normalizeFunnelDiscountCode(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  return code && code.length <= 100 ? code : undefined;
}

/**
 * Owner decision: a funnel discount code applies only to the source (entry)
 * event purchase, never to add-ons, extra events or memberships. The rules
 * mirror normal event checkout: event, ticket class, organisation, member,
 * role, member group, expiry and usage limits. Fixed amounts follow each
 * event kind's normal checkout (per ticket for complex events, per purchase
 * for simple events). Returns per-line savings for the plan; never writes.
 */
export async function quoteFunnelDiscount({ db, tenantId, snapshot, code, now = new Date() }) {
  const source = snapshot.holds.filter(hold => hold.node_id === snapshot.graph.entry);
  if (!source.length) invalid('This discount code cannot be applied to this booking.');
  const found = await db.from('discount_code').select('*').eq('tenant_id', tenantId).eq('is_active', true)
    .ilike('code', literal(code)).limit(2);
  if (found.error || !Array.isArray(found.data)) unavailable();
  if (found.data.length !== 1) invalid('Invalid or inactive discount code');
  const discount = found.data[0];
  if (discount.expires_at && Date.parse(discount.expires_at) <= now.getTime()) invalid('Discount code has expired');
  if (discount.event_id && discount.event_id !== source[0].event_id) invalid('Discount code is not valid for this event');
  const eligible = source.filter(hold => !discount.ticket_class_id || hold.ticket_id === discount.ticket_class_id);
  if (!eligible.length) invalid('This discount code is not valid for your selected ticket');
  const targeted = Boolean(discount.member_id || discount.role_id || discount.member_group_id);
  const max = discount.max_usage_count == null ? null : Number(discount.max_usage_count);
  if (!targeted && max && Number(discount.current_usage_count || 0) >= max) invalid('Discount code has reached maximum uses');
  const memberId = snapshot.session.member_id || null;
  let member = null;
  if (discount.organization_id || targeted) {
    if (!memberId) invalid('Sign in to use this discount code');
    const read = await db.from('member').select('id,organization_id,role_id').eq('tenant_id', tenantId).eq('id', memberId).maybeSingle();
    if (read.error) unavailable();
    member = read.data;
    if (!member) invalid('Discount code is not valid for your account');
  }
  if (discount.organization_id && discount.organization_id !== member.organization_id) invalid('Discount code is not valid for your organization');
  if (discount.member_id && discount.member_id !== member.id) invalid('Discount code is not valid for your account');
  if (discount.role_id && discount.role_id !== member.role_id) invalid('Discount code is not valid for your role');
  if (discount.member_group_id) {
    const group = await db.from('member_group_assignment').select('id').eq('member_id', member.id)
      .eq('group_id', discount.member_group_id).limit(1);
    if (group.error) unavailable();
    if (!group.data?.length) invalid('Discount code is not valid for your group');
  }
  if (targeted && max) {
    const usage = await db.from('discount_code_usage').select('usage_count').eq('discount_code_id', discount.id)
      .eq('member_id', member.id).limit(1);
    if (usage.error) unavailable();
    if (Number(usage.data?.[0]?.usage_count || 0) >= max) invalid('You have reached the maximum uses for this discount code');
  }
  const value = Number(discount.value);
  const percentage = discount.type === 'percentage';
  if (!Number.isFinite(value) || value < 0 || (percentage && value > 100)) invalid('Invalid or inactive discount code');
  const lines = eligible.map(hold => ({ nodeId: hold.node_id, ticketId: hold.ticket_id, eventKind: hold.event_kind,
    quantity: hold.quantity, listMinor: funnelLineTotal(hold.price_snapshot, hold.quantity) }));
  const fixedMinor = Math.round(value * 100);
  if (percentage) {
    for (const line of lines) line.discountMinor = Math.min(line.listMinor, Math.round(line.listMinor * value / 100));
  } else if (lines[0].eventKind === 'simple') {
    const total = lines.reduce((sum, line) => sum + line.listMinor, 0);
    const shares = allocateFunnelAmounts(lines.map(line => ({ amountMinor: line.listMinor })), Math.min(fixedMinor, total));
    lines.forEach((line, index) => { line.discountMinor = shares[index]; });
  } else {
    for (const line of lines) line.discountMinor = Math.min(line.listMinor, fixedMinor * line.quantity);
  }
  const discountMinor = lines.reduce((sum, line) => sum + line.discountMinor, 0);
  if (!(discountMinor > 0)) invalid('This discount code does not reduce the price of your selected ticket');
  return {
    discountCodeId: discount.id, code: discount.code, type: percentage ? 'percentage' : 'fixed', value, discountMinor,
    lines: lines.filter(line => line.discountMinor > 0).map(({ nodeId, ticketId, discountMinor: amount }) => ({ nodeId, ticketId, discountMinor: amount })),
  };
}
