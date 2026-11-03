// Pure safety policy. Authorization and collection cutover are separate acts.
export const REPLACEMENT_MESSAGES = {
  authorizing: 'Authorize your replacement bank details with GoCardless. Your existing mandate and collections remain unchanged.',
  awaiting_confirmation: 'GoCardless authorization is being verified. Your existing mandate and collections remain unchanged.',
  switching: 'Your collection arrangements are being transferred. Please do not start another authorization.',
  action_required: 'Your mandate replacement needs assistance. Please contact your membership team before making another payment arrangement.',
  completed: 'Your Direct Debit mandate has been replaced.',
  cancelled: 'Replacement authorization was cancelled. Your existing mandate and collections remain unchanged.',
};

export function replacementEligibility({ member, histories, agreements, environment, today }) {
  if (!member?.id || !member.tenant_id || !['sandbox', 'live'].includes(environment)) {
    return { eligible: false, canStart: false, reason: 'Membership payment details could not be verified.' };
  }
  const current = histories.filter(row =>
    row.member_id === member.id && row.tenant_id === member.tenant_id
    && !row.organization_id && row.payment_method === 'direct_debit'
    && row.term_start_date && row.term_end_date
    && row.term_start_date <= today && row.term_end_date >= today
    && ['active', 'paid', 'current'].includes(row.status));
  if (!current.length) return { eligible: false, canStart: false };
  const ids = new Set(current.map(row => row.billing_agreement_id).filter(Boolean));
  const owned = agreements.filter(row => ids.has(row.id)
    && row.tenant_id === member.tenant_id && row.member_id === member.id
    && row.agreement_type === 'member' && !row.organization_id
    && row.provider === 'gocardless' && row.environment === environment
    && row.gocardless_mandate_id);
  if (current.length !== 1 || owned.length !== 1) {
    return { eligible: true, canStart: false, reason: 'Please contact your membership team: the current individual Direct Debit agreement needs to be verified.' };
  }
  const agreement = owned[0];
  if (agreement.needs_attention || agreement.metadata?.collection_hold
      || !['active', 'mandate_active', 'payment_plan_active', 'first_payment_pending'].includes(agreement.status)) {
    return { eligible: true, canStart: false, reason: 'Please contact your membership team to review this Direct Debit arrangement.' };
  }
  return { eligible: true, canStart: true, agreement, history: current[0] };
}

// Exhaustive evidence is mandatory: [] alone cannot prove absence of schedules.
export function evaluateReplacementHandover({
  ownershipVerified, externalScheduler, sharedMandate, inventoryComplete,
  oldMandate, newMandate, payments, subscriptions, expectedSubscriptionId,
  remainingObligations, cutoff,
}) {
  const blocked = reason => ({ safe: false, reason });
  if (!ownershipVerified || externalScheduler || sharedMandate) return blocked('ownership_requires_assistance');
  if (!inventoryComplete || !Array.isArray(payments) || !Array.isArray(subscriptions)
      || !Array.isArray(remainingObligations)) return blocked('incomplete_collection_inventory');
  if (!oldMandate?.id || !newMandate?.id || oldMandate.id === newMandate.id
      || oldMandate.status !== 'active' || newMandate.status !== 'active'
      || !oldMandate.links?.creditor || oldMandate.links.creditor !== newMandate.links?.creditor
      || oldMandate.scheme !== newMandate.scheme) return blocked('mandate_identity_or_status');
  // A failed payment can be retried later; it is not safe to discard as settled.
  if (payments.some(payment => payment.links?.mandate !== oldMandate.id
      || !['paid_out', 'cancelled', 'customer_approval_denied'].includes(payment.status))) {
    return blocked('unsettled_or_retryable_payment');
  }
  const liveSubscriptions = subscriptions.filter(sub => !['cancelled', 'finished'].includes(sub.status));
  if (liveSubscriptions.some(sub => sub.id !== expectedSubscriptionId
      || sub.links?.mandate !== oldMandate.id || sub.status !== 'active')) {
    return blocked('unknown_or_unusable_subscription');
  }
  if (expectedSubscriptionId && liveSubscriptions.length !== 1) return blocked('subscription_inventory_mismatch');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff || '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(newMandate.next_possible_charge_date || '')) {
    return blocked('unknown_collection_lead_time');
  }
  const dates = new Set();
  for (const obligation of remainingObligations) {
    if (!Number.isSafeInteger(obligation.amountMinor) || obligation.amountMinor <= 0
        || !/^\d{4}-\d{2}-\d{2}$/.test(obligation.chargeDate || '')
        || obligation.chargeDate < cutoff
        || obligation.chargeDate < newMandate.next_possible_charge_date
        || dates.has(obligation.chargeDate) || !obligation.currency) {
      return blocked('remaining_schedule_requires_assistance');
    }
    dates.add(obligation.chargeDate);
  }
  return { safe: true, remainingObligations };
}
