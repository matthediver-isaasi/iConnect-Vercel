const PUBLIC_PROVIDERS = new Set(['stripe', 'gocardless']);
const PUBLIC_STAGES = new Set([
  'pending',
  'finalizing',
  'setup_complete',
  'paid',
  'blocked',
  'accounting_pending',
]);

/**
 * Build the applicant-facing monthly confirmation contract from evidence
 * already verified by the provider-specific server path. This helper never
 * infers collection from Checkout/setup completion.
 */
export function monthlyConfirmLifecycle({
  provider,
  stage,
  submissionId,
  paymentVerified = false,
  detail = null,
  code = null,
}) {
  const verifiedProvider = PUBLIC_PROVIDERS.has(provider) ? provider : null;
  const verifiedStage = PUBLIC_STAGES.has(stage) ? stage : 'blocked';
  const response = {
    success: ['setup_complete', 'paid'].includes(verifiedStage),
    pending: ['pending', 'finalizing', 'accounting_pending'].includes(verifiedStage),
    provider: verifiedProvider,
    submissionId,
    status: verifiedStage,
    paymentSucceeded: paymentVerified === true,
  };
  if (verifiedStage === 'blocked') {
    response.error = code?.includes('CONFLICT')
      ? 'This membership cannot be completed because it conflicts with an existing membership.'
      : 'Monthly membership processing is blocked. Please contact support.';
    response.code = code || 'MEMBERSHIP_SETUP_BLOCKED';
  } else if (verifiedStage === 'finalizing') {
    response.message = 'Your membership is still being finalized. You can safely check again.';
  } else if (verifiedStage === 'accounting_pending') {
    response.message = 'Your payment was received, but accounting is still being completed. Please do not pay again.';
    response.retryable = true;
  }
  return response;
}

/**
 * Positive collection evidence for a monthly Stripe return. A zero-value paid
 * setup/proration invoice is deliberately not a collected instalment.
 */
export function verifiedStripeMonthlyCollection({
  session,
  invoice,
  tenantId,
  agreementId,
  submissionId,
  environment,
}) {
  const metadata = session?.metadata || {};
  const identityMatches = session?.mode === 'subscription'
    && metadata.kind === 'monthly_card'
    && metadata.tenant_id === String(tenantId)
    && metadata.agreement_id === String(agreementId)
    && metadata.form_submission_id === String(submissionId)
    && session.livemode === (environment === 'live');
  if (!identityMatches || !session.subscription || !invoice?.id) return false;
  return (invoice.paid === true || invoice.status === 'paid')
    && Number(invoice.amount_paid) > 0
    && Number(invoice.amount_remaining) === 0;
}