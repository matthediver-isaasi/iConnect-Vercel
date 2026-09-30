import { normalizeFormAccessPolicy } from './formAccessPolicy.js';

/**
 * Async payment finalizers have no visitor request/session to evaluate.
 * Unrestricted forms remain backwards-compatible. Restricted (or malformed)
 * policies require the authorization timestamp written by the payment-start
 * endpoint after the live form policy was satisfied.
 */
export function hasFormPaymentAccessProof(submission, form) {
  if (!form) return false;
  const normalized = normalizeFormAccessPolicy(form.access_policy);
  if (!normalized.ok) return false;
  if (!normalized.restricted) return true;
  const authorizedAt = submission?.payment_meta?.access_authorized_at;
  return typeof authorizedAt === 'string' && Number.isFinite(Date.parse(authorizedAt));
}

export function withFormPaymentAccessProof(paymentMeta, {
  authorizedAt = new Date().toISOString(),
  accessPolicyRequired = true,
} = {}) {
  return {
    ...((paymentMeta && typeof paymentMeta === 'object') ? paymentMeta : {}),
    access_authorized_at: authorizedAt,
    access_policy_required: !!accessPolicyRequired,
  };
}