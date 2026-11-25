// Email copy for complimentary membership benefits granted by an event funnel
// order. Eligibility only: wording never promises activation, start dates or
// that a membership exists. Copy mirrors EventFunnelMembershipOffer.jsx.
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
// Benefits can only exist once the membership-stage migration is installed;
// a missing relation is therefore authoritative "no benefits", not a failure.
const MISSING_RELATION = new Set(['42P01', 'PGRST205']);

/** Entitlements recorded for one order, oldest first. Throws on read failure. */
export async function loadFunnelOrderBenefits(db, tenantId, orderId) {
  const { data, error } = await db.from('event_funnel_membership_entitlement')
    .select('id,node_id,scope,benefit_snapshot,withdrawn_at,withdrawn_by_reversal')
    .eq('tenant_id', tenantId).eq('order_id', orderId).order('granted_at', { ascending: true }).order('id', { ascending: true });
  if (MISSING_RELATION.has(error?.code)) return [];
  if (error || !Array.isArray(data)) throw new Error('Membership benefit evidence could not be read');
  return data;
}

const coversBooking = (entitlement, bookingId) => bookingId != null
  && Array.isArray(entitlement?.benefit_snapshot?.qualifyingBookingIds)
  && entitlement.benefit_snapshot.qualifyingBookingIds.map(String).includes(String(bookingId));

export const grantedBenefitsForBooking = (entitlements, bookingId) =>
  (entitlements || []).filter(e => !e.withdrawn_at && coversBooking(e, bookingId));

export const withdrawnBenefitsForBooking = (entitlements, bookingId, reversalId) =>
  (entitlements || []).filter(e => e.withdrawn_at && e.withdrawn_by_reversal != null
    && String(e.withdrawn_by_reversal) === String(reversalId) && coversBooking(e, bookingId));

const tierName = e => e.benefit_snapshot?.scheduleName || 'Membership';

export function benefitRecipientLabel(entitlement) {
  const scope = entitlement.scope || entitlement.benefit_snapshot?.scope;
  if (scope === 'organization') return 'Organisation membership, added to the booking purchaser’s organisation';
  if (entitlement.benefit_snapshot?.recipientMode === 'attendees') return 'Individual membership for you, as the named attendee on this booking';
  return 'Individual membership for the person who made this booking';
}

const list = (items, render) => `<ul>${items.map(item => `<li>${render(item)}</li>`).join('')}</ul>`;

export function renderGrantedBenefitsHtml(entitlements) {
  if (!entitlements?.length) return '';
  return '<div data-funnel-membership="granted"><h3>Complimentary membership included</h3>'
    + '<p>This booking includes a complimentary membership benefit:</p>'
    + list(entitlements, e => `<strong>${escape(tierName(e))}</strong> — ${escape(benefitRecipientLabel(e))}`)
    + '<p>Each benefit covers the base fee for one membership period, waived once. The membership has not been started by this booking: '
    + 'the waiver is applied when that membership period is next created. Any add-ons and later periods are charged normally.</p></div>';
}

export function renderWithdrawnBenefitsHtml(entitlements) {
  if (!entitlements?.length) return '';
  return '<p>Because this booking was cancelled, the following unused complimentary membership benefit has been withdrawn:</p>'
    + list(entitlements, e => `<strong>${escape(tierName(e))}</strong> — ${escape(benefitRecipientLabel(e))}`);
}
