import { addDays, toDateString } from './annualRenewalPolicy.js';
import { buildRollingTerm, rollingDateString } from '../../shared/rollingMembershipTerm.js';

const retired = new Set(['cancelled', 'canceled', 'void', 'expired_checkout', 'replaced', 'cancelled_by_request']);
const closedAgreements = new Set(['cancelled', 'canceled', 'completed', 'expired']);
const deny = reason => ({ eligible: false, reason });

/**
 * Read-only late-renewal assessment of server-loaded evidence.
 * This does not authorize checkout, reserve a term or change membership access.
 * The database reservation and confirmed-payment finalizer are separate gates.
 */
export function assessPostGraceRenewal({
  tenantId, member, histories, agreements, elections = [], configs, enabled = false,
  today = new Date(), selectedConfigId = null,
}) {
  if (!enabled) return deny('post_grace_disabled');
  try {
    const day = rollingDateString(today);
    if (!tenantId || !member?.id || member.tenant_id !== tenantId
        || ![histories, agreements, elections, configs].every(Array.isArray)) {
      return deny('evidence_unavailable');
    }
    if (member.membership_paused || member.membership_cancelled) return deny('membership_paused_or_cancelled');
    if ([...histories, ...agreements, ...elections].some(row =>
      row.tenant_id !== tenantId || row.member_id !== member.id || row.organization_id)) {
      return deny('evidence_scope_mismatch');
    }
    if (configs.some(row => row.tenant_id !== tenantId)) return deny('config_scope_mismatch');
    if (agreements.some(row => !closedAgreements.has(row.status))) return deny('unresolved_billing_agreement');
    if (elections.some(row => row.status !== 'released')) return deny('successor_already_reserved');
    const retained = histories.filter(row => !retired.has(row.status));
    if (!retained.length) return deny('previous_membership_required');
    if (retained.some(row => !row.term_start_date || !row.term_end_date)) return deny('incomplete_term_evidence');
    const ordered = retained.map(row => ({
      row, start: rollingDateString(row.term_start_date), end: rollingDateString(row.term_end_date),
    })).sort((a, b) => b.start.localeCompare(a.start));
    if (ordered.some(term => term.start > term.end)) return deny('invalid_term_evidence');
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].end >= ordered[i - 1].start) return deny('overlapping_terms');
    }
    const { row: prior, start, end } = ordered[0];
    if (start > day || end >= day) return deny('membership_not_expired');
    if (prior.payment_status !== 'paid' || prior.billing_agreement_id
        || prior.commitment_snapshot?.payment_frequency === 'monthly') return deny('previous_settlement_requires_review');
    const config = prior.effective_commitment_snapshot?.config
      || prior.renewal_policy_snapshot || prior.commitment_snapshot?.config || prior.incentive_snapshot?.config;
    if (!config || config.tenant_id !== tenantId || config.structure_scope_type !== 'member') {
      return deny('previous_class_unavailable');
    }
    const grace = config.renewal_grace_days;
    if (grace == null || grace === '' || !Number.isInteger(Number(grace))
        || Number(grace) < 0 || Number(grace) > 366) return deny('grace_policy_unavailable');
    const rolling = String(prior.term_key || '').startsWith('rolling:');
    const next = toDateString(addDays(end, 1));
    if (rolling && (!prior.membership_renewal_date
        || rollingDateString(prior.membership_renewal_date) !== next)) return deny('inconsistent_renewal_boundary');
    const graceEnd = toDateString(addDays(rolling ? next : end, Number(grace)));
    if (day <= graceEnd) return deny('still_within_grace');
    // Access role, including Former, is deliberately not a membership-class selector.
    const equal = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    if (!selectedConfigId && (!config.structure_field_id || !String(config.structure_match_value || '').trim())) {
      return deny('previous_class_unavailable');
    }
    const candidates = configs.filter(item => item.is_active !== false
      && item.structure_scope_type === 'member' && item.billing_period === 'annual'
      && (selectedConfigId ? item.id === selectedConfigId
        : equal(item.structure_field_id, config.structure_field_id)
          && equal(item.structure_match_value, config.structure_match_value))
      && (!item.effective_from || rollingDateString(item.effective_from) <= day)
      && (!item.effective_to || rollingDateString(item.effective_to) >= day));
    if (candidates.length !== 1) return deny('current_schedule_ambiguous_or_unavailable');
    const target = candidates[0];
    return {
      eligible: true, state: 'post_grace_renewal', predecessorId: prior.id,
      configId: target.id, scheduleName: target.name,
      previousClass: config.structure_match_value, graceEndDate: graceEnd,
      commencementBasis: 'confirmed_payment', provisional: true,
      // Fixed-year settings must not silently shorten a post-grace paid year.
      ...paymentDatedRenewalTerm(day),
    };
  } catch {
    return deny('invalid_membership_evidence');
  }
}

export function paymentDatedRenewalTerm(paymentDate) {
  return buildRollingTerm({ startDate: rollingDateString(paymentDate), billingPeriod: 'annual' });
}

/**
 * Only the verified provider's successful payment timestamp establishes dates.
 * Checkout creation, redirect return, mandate setup and webhook receipt times
 * are not payment evidence. Callers must persist the first accepted evidence
 * atomically; repeated notifications must return that original decision.
 */
export function planPostGraceSettlement({ reservation, evidence, now = new Date() }) {
  if (!reservation || reservation.commencementBasis !== 'confirmed_payment') throw new Error('Not a post-grace reservation');
  const providerForMethod = { upfront: ['stripe', 'credit'], monthly_card: ['stripe'], direct_debit: ['gocardless'] };
  if (!providerForMethod[reservation.paymentMethod]?.includes(evidence?.provider)) {
    throw new Error('Payment provider does not match reserved method');
  }
  if (!['stripe', 'gocardless', 'credit'].includes(evidence?.provider)
      || !['succeeded', 'confirmed', 'paid_out', 'fully_allocated'].includes(evidence?.status)
      || !evidence.id || evidence.tenantId !== reservation.tenantId
      || evidence.memberId !== reservation.memberId || evidence.reservationId !== reservation.id) {
    throw new Error('Verified scoped payment evidence is required');
  }
  const statuses = { stripe: ['succeeded'], gocardless: ['confirmed', 'paid_out'], credit: ['fully_allocated'] };
  if (!statuses[evidence.provider].includes(evidence.status)) throw new Error('Payment status does not match provider');
  const paidAt = new Date(evidence.paidAt);
  const createdAt = new Date(reservation.createdAt);
  if (!evidence.paidAt || !reservation.createdAt || !Number.isFinite(+createdAt)
      || !Number.isFinite(+new Date(now)) || !Number.isFinite(+paidAt) || paidAt > new Date(now)
      || paidAt < createdAt) throw new Error('Invalid confirmed payment timestamp');
  if (!Number.isSafeInteger(evidence.amountMinor) || evidence.amountMinor < 0
      || evidence.currency !== reservation.currency || !Number.isSafeInteger(reservation.firstPaymentMinor)
      || evidence.amountMinor !== reservation.firstPaymentMinor) throw new Error('Payment amount does not match reservation');
  if (evidence.provider !== 'credit' && evidence.amountMinor === 0) throw new Error('Zero cash is not payment evidence');
  if (evidence.provider === 'credit' && reservation.paymentMethod !== 'upfront') {
    throw new Error('Monthly credit does not establish provider payment commencement');
  }
  if (!reservation.graceEndDate || rollingDateString(paidAt) <= reservation.graceEndDate) {
    throw new Error('Payment is not after grace');
  }
  return {
    ...paymentDatedRenewalTerm(paidAt),
    paymentEvidence: { provider: evidence.provider, id: evidence.id, paidAt: paidAt.toISOString() },
  };
}
