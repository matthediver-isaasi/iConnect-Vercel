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
  paymentProvider = null,
  setupVerified = null,
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
  // These two fields are deliberately opt-in.  Recovery, webhook, and legacy
  // callers retain their existing response shape; the browser acknowledgement
  // contract opts in only after its provider-specific setup proof is complete.
  if (paymentProvider) response.paymentProvider = paymentProvider;
  if (setupVerified !== null) response.setupVerified = setupVerified === true;
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
 * Validate the provider evidence needed to acknowledge a Stripe monthly
 * Checkout without running membership/accounting work in the request.
 *
 * Checkout `complete` is not sufficient on its own: Stripe can subsequently
 * report an incomplete-expired or canceled subscription.  The subscription
 * must be expanded so the acknowledgement is based on its current state.
 */
export function verifiedStripeMonthlySetup({
  session,
  tenantId,
  agreementId,
  submissionId,
  environment,
  agreementStatus = null,
}) {
  const metadata = session?.metadata || {};
  const subscription = session?.subscription;
  const identityMatches = session?.status === 'complete'
    && session?.mode === 'subscription'
    && metadata.kind === 'monthly_card'
    && metadata.tenant_id === String(tenantId)
    && metadata.agreement_id === String(agreementId)
    && metadata.form_submission_id === String(submissionId)
    && session.livemode === (environment === 'live');
  if (['expired', 'payment_plan_cancelled'].includes(agreementStatus)) return false;
  if (!identityMatches || !subscription || typeof subscription !== 'object') return false;
  // past_due/unpaid are collection failures, not a verified recurring setup.
  if (!['active', 'trialing'].includes(subscription.status)) return false;
  const invoice = subscription.latest_invoice;
  if (invoice && typeof invoice === 'object') {
    if (['void', 'uncollectible'].includes(invoice.status)
        || invoice.refunded === true
        || invoice.charge?.refunded === true
        || ['canceled', 'requires_payment_method', 'requires_action']
          .includes(invoice.payment_intent?.status)) {
      return false;
    }
    const charges = invoice.payment_intent?.charges?.data;
    if (Array.isArray(charges) && charges.some((charge) => charge?.refunded === true)) return false;
  }
  return true;
}

/**
 * GoCardless setup proof for the browser acknowledgement path. A fulfilled
 * Billing Request plus a provider mandate in any consent-established state is
 * durable setup proof; bank activation is intentionally not required here.
 * No payment is inferred from either signal.
 */
export function verifiedGocardlessMonthlySetup({
  billingRequest,
  mandate,
  tenantId,
  agreementId,
  submissionId,
  environment,
  agreementStatus = null,
}) {
  const metadata = billingRequest?.metadata || {};
  const mandateId = billingRequest?.links?.mandate_request_mandate;
  if (['expired', 'payment_plan_cancelled'].includes(agreementStatus)) return false;
  return billingRequest?.status === 'fulfilled'
    && metadata.type === 'form_monthly_direct_debit'
    && metadata.form_submission_id === String(submissionId)
    && metadata.agreement_id === String(agreementId)
    && !!mandateId
    && String(mandate?.id || '') === String(mandateId)
    && ['pending_submission', 'submitted', 'active', 'reinstated'].includes(mandate?.status)
    && !!tenantId
    && !!environment;
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
  if (invoice.refunded === true
      || invoice.charge?.refunded === true
      || invoice.payment_intent?.charges?.data?.some((charge) => charge?.refunded === true)) {
    return false;
  }
  return (invoice.paid === true || invoice.status === 'paid')
    && Number(invoice.amount_paid) > 0
    && Number(invoice.amount_remaining) === 0;
}