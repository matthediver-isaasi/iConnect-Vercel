// Confirmed-cancelled individual recurring-plan restart evidence.
//
// Owner decision: a confirmed-cancelled individual GoCardless Direct Debit, or
// a Stripe monthly card plan whose subscription Stripe confirmed as ended,
// qualifies for the payment-dated restart journey straight away (no failed
// payment, grace expiry, approval or payment-grace exit needed). The database
// function membership_cancelled_dd_restart_evidence is the single shared test
// for both providers:
//   - GoCardless: agreement and plan payment_plan_cancelled after an
//     API-confirmed cancelled/failed/expired mandate (the webhook's terminal).
//   - Stripe: the unfinished card plan moved to payment_plan_cancelled by the
//     subscription-deleted webhook or by reconciliation that saw the
//     subscription canceled. The card agreement keeps its own status.
// This module only attaches that server-loaded evidence.

export const CANCELLED_DD_STATUSES = new Set(['payment_plan_cancelled', 'cancelled', 'canceled']);
export const CARD_PLAN_KIND = 'monthly_card';
// A concluded card agreement was completed, not cancelled.
const CONCLUDED_CARD_STATUSES = new Set(['completed', 'expired']);
const MISSING_FUNCTION = new Set(['42883', 'PGRST202']);

const individualCardAgreement = row => row?.provider === 'stripe' && !row.organization_id
  && !row.cancelled_for_switch_at && row.metadata?.card?.kind === CARD_PLAN_KIND
  && !row.metadata?.form_conflict_resolution;

/** Cheap pre-filter: could this predecessor's agreement be a cancelled recurring plan? */
export function mayHaveCancelledDirectDebit(history, agreements = []) {
  if (!history?.billing_agreement_id || history.organization_id || history.payment_grace_exit_id) return false;
  return agreements.some(row => row.id === history.billing_agreement_id && !row.organization_id
    && ((row.provider === 'gocardless' && CANCELLED_DD_STATUSES.has(row.status))
      || (individualCardAgreement(row) && !CONCLUDED_CARD_STATUSES.has(row.status))));
}

function providerEvidence(evidence) {
  if (evidence.provider === 'stripe') {
    return evidence.plan_status === 'payment_plan_cancelled'
      && !CONCLUDED_CARD_STATUSES.has(evidence.agreement_status)
      && Boolean(evidence.stripe_subscription_id) && Boolean(evidence.cancellation_confirmed_at)
      && !evidence.mandate_status;
  }
  // Evidence from before card plans were supported carries no provider.
  return (evidence.provider == null || evidence.provider === 'gocardless')
    && CANCELLED_DD_STATUSES.has(evidence.agreement_status) && CANCELLED_DD_STATUSES.has(evidence.plan_status)
    && ['cancelled', 'failed', 'expired'].includes(evidence.mandate_status);
}

/** Pure check of attached evidence; used by the read-only restart assessment. */
export function confirmedCancelledDirectDebit(history, tenantId, memberId) {
  const evidence = history?.cancelledDirectDebit;
  return Boolean(evidence && !history.payment_grace_exit_id && !history.organization_id
    && evidence.tenant_id === tenantId && evidence.member_id === memberId
    && evidence.history_id === history.id && evidence.agreement_id === history.billing_agreement_id
    && providerEvidence(evidence)
    && (!evidence.supersession || (evidence.supersession.provider ?? 'gocardless') === (evidence.provider ?? 'gocardless'))
    && (!history.restart_supersession_id || evidence.supersession?.id === history.restart_supersession_id));
}

/** True for a confirmed-cancelled Stripe monthly card plan (vs a Direct Debit). */
export function isCancelledCardPlanEvidence(history) {
  return history?.cancelledDirectDebit?.provider === 'stripe';
}

/**
 * The exact agreement bound to confirmed cancellation evidence. A cancelled
 * Direct Debit agreement carries a cancelled status; a card agreement keeps
 * its own status, so it is recognised only through its bound evidence.
 */
export function isConfirmedCancelledAgreement(agreement, restartHistories = []) {
  return restartHistories.some(row => row.billing_agreement_id === agreement?.id
    && (isCancelledCardPlanEvidence(row)
      ? agreement.provider === 'stripe' && !CONCLUDED_CARD_STATUSES.has(agreement.status)
      : CANCELLED_DD_STATUSES.has(agreement.status)));
}

export async function attachCancelledDirectDebitEvidence(db, tenantId, memberId, histories) {
  return Promise.all(histories.map(async history => {
    if (!history.billing_agreement_id || history.payment_grace_exit_id || history.organization_id) return history;
    if (history.tenant_id !== tenantId || history.member_id !== memberId) {
      throw new Error('Cancelled recurring plan ownership mismatch');
    }
    const { data, error } = await db.rpc('membership_cancelled_dd_restart_evidence', {
      p_tenant_id: tenantId, p_member_id: memberId, p_history_id: history.id,
    });
    // Before the migration is installed there is simply no such evidence.
    if (error && MISSING_FUNCTION.has(error.code)) return history;
    if (error) throw new Error('Cancelled recurring plan evidence could not be verified');
    if (!data) return history;
    const attached = { ...history, cancelledDirectDebit: data };
    if (!confirmedCancelledDirectDebit(attached, tenantId, memberId)) {
      throw new Error('Cancelled recurring plan evidence could not be verified');
    }
    return attached;
  }));
}

/**
 * A cancelled recurring-plan term that a completed restart superseded. The link
 * column can only be set by the reservation function (bound, immutable), and
 * 'expired' plus a paid successor proves the restart payment was confirmed.
 * Such a term keeps its original dates and debt as evidence, but ordinary
 * renewal discovery must treat it (and its cancelled agreement) as history.
 */
export function isSupersededRestartTerm(row, histories = []) {
  return Boolean(row?.restart_supersession_id && row.status === 'expired' && !row.organization_id
    && histories.some(successor => successor.previous_term_id === row.id
      && successor.membership_successor_election_id && successor.payment_status === 'paid'
      && successor.tenant_id === row.tenant_id && successor.member_id === row.member_id));
}

export function supersededRestartAgreementIds(histories = []) {
  return new Set(histories.filter(row => isSupersededRestartTerm(row, histories) && row.billing_agreement_id)
    .map(row => row.billing_agreement_id));
}

/**
 * The agreement of a superseded restart term is history: a cancelled Direct
 * Debit (cancelled status), or the individual card agreement, which keeps the
 * status it had when Stripe ended its subscription.
 */
export function isSupersededRestartAgreement(agreement, supersededIds) {
  return Boolean(agreement && supersededIds.has(agreement.id) && !agreement.organization_id
    && (CANCELLED_DD_STATUSES.has(agreement.status)
      || (agreement.provider === 'stripe' && !CONCLUDED_CARD_STATUSES.has(agreement.status))));
}
