/**
 * Separately assigned renewal authority for a settled historical instalment
 * year. This is NOT a historical pricing snapshot or a new DD agreement.
 * Accept server-loaded financial history only; notes alone never authorize it.
 */
export function reviewedHistoricalRenewalConfig(history) {
  const policy = history?.renewal_policy_snapshot;
  const review = policy?.historical_settlement_renewal;
  if (review?.version !== 1 || review.history_id !== history.id
      || review.member_id !== history.member_id || review.tenant_id !== history.tenant_id
      || !review.approved_at || !review.mandate_id || review.mandate_status !== 'cancelled'
      || !review.provider_verified_at || review.start !== history.term_start_date
      || review.end !== history.term_end_date || history.organization_id
      || history.billing_agreement_id || history.term_key || history.commitment_snapshot
      || !['active', 'expired'].includes(history.status) || history.payment_status !== 'paid'
      || history.payment_method !== 'direct_debit' || history.billing_period !== 'annual'
      || !history.term_start_date || !history.term_end_date
      || policy.tenant_id !== history.tenant_id || !policy.id
      || policy.structure_scope_type !== 'member' || policy.billing_period !== 'annual'
      || policy.start_mode !== 'immediate'
      || !Number.isSafeInteger(review.cash_minor) || !Number.isSafeInteger(review.credit_minor)
      || review.cash_minor < 0 || review.credit_minor < 0
      || review.cash_minor + review.credit_minor !== Math.round(Number(history.total_with_vat) * 100)
      || review.currency !== history.currency
      || ![policy.renewal_open_days, policy.renewal_grace_days].every(value =>
        Number.isInteger(value) && value >= 0 && value <= 366)) return null;
  return policy;
}
