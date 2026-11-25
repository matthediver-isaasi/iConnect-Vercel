// Confirmed-cancelled individual GoCardless Direct Debit restart evidence.
//
// Owner decision: a confirmed-cancelled individual Direct Debit qualifies for
// the payment-dated restart journey straight away (no failed payment, grace
// expiry, approval or payment-grace exit needed). The database function
// membership_cancelled_dd_restart_evidence is the single shared test: it uses
// the same terminal confirmation as the GoCardless webhook (agreement and plan
// payment_plan_cancelled after an API-confirmed cancelled/failed/expired
// mandate). This module only attaches that server-loaded evidence.

export const CANCELLED_DD_STATUSES = new Set(['payment_plan_cancelled', 'cancelled', 'canceled']);
const MISSING_FUNCTION = new Set(['42883', 'PGRST202']);

/** Cheap pre-filter: could this predecessor's agreement be a cancelled DD? */
export function mayHaveCancelledDirectDebit(history, agreements = []) {
  if (!history?.billing_agreement_id || history.organization_id || history.payment_grace_exit_id) return false;
  return agreements.some(row => row.id === history.billing_agreement_id
    && !row.organization_id && row.provider === 'gocardless' && CANCELLED_DD_STATUSES.has(row.status));
}

/** Pure check of attached evidence; used by the read-only restart assessment. */
export function confirmedCancelledDirectDebit(history, tenantId, memberId) {
  const evidence = history?.cancelledDirectDebit;
  return Boolean(evidence && !history.payment_grace_exit_id && !history.organization_id
    && evidence.tenant_id === tenantId && evidence.member_id === memberId
    && evidence.history_id === history.id && evidence.agreement_id === history.billing_agreement_id
    && CANCELLED_DD_STATUSES.has(evidence.agreement_status) && CANCELLED_DD_STATUSES.has(evidence.plan_status)
    && ['cancelled', 'failed', 'expired'].includes(evidence.mandate_status)
    && (!history.restart_supersession_id || evidence.supersession?.id === history.restart_supersession_id));
}

export async function attachCancelledDirectDebitEvidence(db, tenantId, memberId, histories) {
  return Promise.all(histories.map(async history => {
    if (!history.billing_agreement_id || history.payment_grace_exit_id || history.organization_id) return history;
    if (history.tenant_id !== tenantId || history.member_id !== memberId) {
      throw new Error('Cancelled Direct Debit ownership mismatch');
    }
    const { data, error } = await db.rpc('membership_cancelled_dd_restart_evidence', {
      p_tenant_id: tenantId, p_member_id: memberId, p_history_id: history.id,
    });
    // Before the migration is installed there is simply no such evidence.
    if (error && MISSING_FUNCTION.has(error.code)) return history;
    if (error) throw new Error('Cancelled Direct Debit evidence could not be verified');
    if (!data) return history;
    const attached = { ...history, cancelledDirectDebit: data };
    if (!confirmedCancelledDirectDebit(attached, tenantId, memberId)) {
      throw new Error('Cancelled Direct Debit evidence could not be verified');
    }
    return attached;
  }));
}

/**
 * A cancelled Direct Debit term that a completed restart superseded. The link
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
