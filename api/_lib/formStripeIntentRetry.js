import { retrieveTenantPaymentIntent } from './stripeCredentials.js';

const REUSABLE_INTENT_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
]);

/**
 * Resolve an already-published form PaymentIntent across both Stripe modes.
 * A same-key retry must never create a replacement while the original intent
 * remains payable in the account selected before an admin mode change.
 */
export async function inspectPriorFormStripeIntent({
  tenantId,
  stripeFeature,
  paymentIntentId,
  amountMinor,
  currency,
  retrievePaymentIntent = retrieveTenantPaymentIntent,
}) {
  if (!paymentIntentId) return { kind: 'none' };

  let found;
  try {
    found = await retrievePaymentIntent(tenantId, stripeFeature, paymentIntentId);
  } catch (error) {
    const missing = error?.code === 'resource_missing' || error?.statusCode === 404;
    if (missing) return { kind: 'missing' };
    throw error;
  }
  if (!found?.paymentIntent) return { kind: 'missing' };

  const intent = found.paymentIntent;
  if (intent.status === 'succeeded') {
    return { kind: 'succeeded', intent };
  }
  if (REUSABLE_INTENT_STATUSES.has(intent.status)
      && intent.amount === amountMinor
      && intent.currency === currency.toLowerCase()) {
    if (!found.publishableKey) {
      return {
        kind: 'blocked',
        intent,
        error: new Error('The publishable key for the existing Stripe intent is unavailable'),
      };
    }
    return {
      kind: 'reusable',
      intent,
      publishableKey: found.publishableKey,
    };
  }
  if (intent.status !== 'canceled') {
    try {
      await found.stripe.paymentIntents.cancel(intent.id);
    } catch (error) {
      return { kind: 'blocked', intent, error };
    }
  }
  return { kind: 'replace', intent };
}