import { addDays, toDateString } from './annualRenewalPolicy.js';
import { addCalendarMonths, billingPeriodMonths, rollingDateString } from '../../shared/rollingMembershipTerm.js';
import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';

const discarded = new Set(['cancelled', 'canceled', 'void', 'expired_checkout']);
const date = value => {
  if (!value) throw new Error('Missing persisted membership date');
  return rollingDateString(value);
};
const review = reason => ({ state: 'review_required', eligible: false, reason });

/**
 * Read-only assessment of SERVER-LOADED evidence. This is not a checkout
 * authorization: an atomic, cross-provider reservation is still required.
 * Never pass a request body as evidence or use this to bypass annual guards.
 */
export function assessFormMembershipRenewalEvidence({
  tenantId, memberId, organizationId = null, histories, agreements,
  successorConfig = null, paused = false, now = new Date(),
}) {
  if (!tenantId || (!!memberId === !!organizationId)
      || !Array.isArray(histories) || !Array.isArray(agreements)) {
    return review('membership_evidence_unavailable');
  }
  const ownerKey = organizationId ? 'organization_id' : 'member_id';
  const ownerId = organizationId || memberId;
  if ([...histories, ...agreements].some(row => row.tenant_id !== tenantId || row[ownerKey] !== ownerId)) {
    return review('membership_evidence_scope_mismatch');
  }
  if (paused) return { state: 'paused', eligible: false };
  try {
    const today = date(now);
    const retained = histories.filter(row => !discarded.has(row.status));
    const openAgreements = agreements.filter(row => !discarded.has(row.status)
      && !['completed', 'expired'].includes(row.status));
    if (!retained.length) {
      return openAgreements.length
        ? { state: 'renewal_pending', eligible: false }
        : { state: 'joining', eligible: false, reason: 'use_joining_checkout' };
    }
    // Even an approved expiry-only record is not proof of a purchased term.
    const terms = retained.map(row => {
      const start = date(row.term_start_date);
      const end = date(row.term_end_date);
      if (!row.id || start > end) throw new Error('Invalid purchased term');
      return { row, start, end };
    }).sort((a, b) => b.start.localeCompare(a.start));
    for (let index = 1; index < terms.length; index++) {
      if (terms[index].end >= terms[index - 1].start) return review('overlapping_membership_terms');
    }
    const current = terms.find(term => term.start <= today);
    if (!current) return { state: 'renewal_pending', eligible: false, reason: 'initial_term_not_started' };
    const { row, start, end } = current;
    const purchasedConfig = row.renewal_policy_snapshot || row.commitment_snapshot?.config || row.incentive_snapshot?.config;
    if (!purchasedConfig || (purchasedConfig.tenant_id && purchasedConfig.tenant_id !== tenantId)) {
      return review('purchased_policy_unavailable');
    }
    const window = {};
    for (const key of ['renewal_open_days', 'renewal_grace_days']) {
      const value = purchasedConfig[key];
      if (value == null || value === '' || !Number.isInteger(Number(value))
          || Number(value) < 0 || Number(value) > 366) return review('purchased_window_unavailable');
      window[key] = Number(value);
    }
    const nextStart = toDateString(addDays(end, 1));
    const rolling = String(row.term_key || '').startsWith('rolling:');
    if ((rolling && !row.membership_renewal_date)
        || (row.membership_renewal_date && date(row.membership_renewal_date) !== nextStart)) {
      return review('inconsistent_renewal_boundary');
    }
    const anchor = rolling ? nextStart : end;
    const common = {
      predecessorId: row.id, currentStart: start, currentEnd: end, successorStart: nextStart,
      opensOn: toDateString(addDays(anchor, -window.renewal_open_days)),
      closesOn: toDateString(addDays(anchor, window.renewal_grace_days)),
      currentPaymentStatus: row.payment_status || 'unknown',
      currentAgreementId: row.billing_agreement_id || null,
    };
    const future = terms.filter(term => term.start > today);
    if (future.length > 1 || (future[0] && (future[0].start !== nextStart
        || (future[0].row.previous_term_id && future[0].row.previous_term_id !== row.id)))) {
      return review('ambiguous_successor');
    }
    if (future.length) return {
      ...common, eligible: false,
      state: future[0].row.payment_status === 'paid' ? 'next_term_purchased' : 'renewal_pending',
      successorEnd: future[0].end,
    };
    const currentAgreements = openAgreements.filter(agreement => agreement.id === row.billing_agreement_id);
    if (openAgreements.some(agreement => agreement.id !== row.billing_agreement_id)) {
      return { ...common, state: 'renewal_pending', eligible: false };
    }
    if (row.billing_agreement_id && currentAgreements.length !== 1) {
      return review('current_agreement_unavailable');
    }
    if (currentAgreements.length) {
      const agreement = currentAgreements[0];
      if (agreement.status !== 'active') {
        return { ...common, state: 'renewal_pending', eligible: false, reason: 'current_agreement_requires_review' };
      }
      if (!['gocardless', 'stripe'].includes(agreement.provider)) return review('unknown_recurring_provider');
      const snapshot = agreement.metadata?.[agreement.provider === 'stripe' ? 'card' : 'dd'];
      const policy = resolveSavedCollectionPolicy(snapshot);
      if (policy.needs_review) return review('collection_continuation_not_evidenced');
      common.continuesAutomatically = policy.end_policy === 'continue';
    }
    if (!row.billing_agreement_id && row.commitment_snapshot?.payment_frequency === 'monthly') {
      return review('recurring_commitment_without_agreement');
    }
    if (!row.billing_agreement_id && row.payment_status !== 'paid') {
      return { ...common, state: 'current_membership', eligible: false, reason: 'current_payment_not_settled' };
    }
    if (!successorConfig || successorConfig.tenant_id !== tenantId
        || successorConfig.structure_scope_type !== (organizationId ? 'organization' : 'member')
        || successorConfig.is_active === false
        || (successorConfig.effective_from && successorConfig.effective_from > nextStart)
        || (successorConfig.effective_to && successorConfig.effective_to < nextStart)) {
      return common.continuesAutomatically
        ? { ...common, state: 'continuing_arrangement', eligible: false, reason: 'successor_structure_unavailable' }
        : review('successor_structure_unavailable');
    }
    const renewal = addCalendarMonths(nextStart, billingPeriodMonths(successorConfig.billing_period),
      rolling ? date(row.term_anchor_date) : nextStart);
    if (rolling && row.term_anchor_date > start) return review('invalid_term_anchor');
    common.successorEnd = toDateString(addDays(renewal, -1));
    if (today < common.opensOn) return {
      ...common, state: common.continuesAutomatically ? 'continuing_arrangement' : 'renewal_not_open', eligible: false,
    };
    if (today > common.closesOn) return {
      ...common, state: common.continuesAutomatically ? 'continuing_arrangement' : 'renewal_closed', eligible: false,
    };
    return { ...common, state: common.continuesAutomatically ? 'continuing_arrangement' : 'eligible_renewal', eligible: true };
  } catch {
    return review('invalid_membership_evidence');
  }
}