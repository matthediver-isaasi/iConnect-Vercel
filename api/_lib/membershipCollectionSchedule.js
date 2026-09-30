// Operational timing is not a membership commencement date or a pricing preview.
import { getStripeIntegrationCredentials } from './stripeCredentials.js';

export function unavailableCollectionSchedule(provider, reason) {
  return { provider, regularDay: null, nextConfirmedDate: null, evidence: 'unavailable',
    canEdit: false, reason, planId: null, version: null };
}

function timestampDate(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

export async function loadStripeCollectionSchedule({
  tenantId, agreement, plan, getCredentials = getStripeIntegrationCredentials,
  now = new Date(),
  createClient = async (key) => {
    const Stripe = (await import('stripe')).default;
    return new Stripe(key, { timeout: 10000, maxNetworkRetries: 0 });
  },
}) {
  const unavailable = (reason) => unavailableCollectionSchedule('stripe', reason);
  if (!agreement || agreement.tenant_id !== tenantId || agreement.provider !== 'stripe'
    || !plan || plan.tenant_id !== tenantId || plan.billing_agreement_id !== agreement.id
    || plan.provider !== 'stripe') return unavailable('Stripe schedule ownership could not be verified.');
  const environment = agreement.environment;
  if (!['test', 'live'].includes(environment)
    || (plan.environment && plan.environment !== environment)) {
    return unavailable('The recorded Stripe payment mode is missing or inconsistent.');
  }
  const subscriptionId = plan.stripe_subscription_id || agreement.stripe_subscription_id;
  if (!subscriptionId || (plan.stripe_subscription_id && agreement.stripe_subscription_id
    && plan.stripe_subscription_id !== agreement.stripe_subscription_id)) {
    return unavailable('Stripe subscription evidence is missing or inconsistent.');
  }
  try {
    // Never use the current feature mode, platform credentials, or an alternate
    // account when reading a purchased subscription.
    const credentials = await getCredentials(tenantId);
    const key = environment === 'test' ? credentials?.test_secret_key : credentials?.secret_key;
    if (!key) return unavailable('Credentials for the recorded Stripe payment mode are unavailable.');
    const client = await createClient(key);
    const subscription = await client.subscriptions.retrieve(subscriptionId);
    if (subscription.id !== subscriptionId || subscription.livemode !== (environment === 'live')) {
      return unavailable('Stripe returned inconsistent subscription evidence.');
    }
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (agreement.stripe_customer_id && customerId !== agreement.stripe_customer_id) {
      return unavailable('Stripe subscription customer does not match the saved agreement.');
    }
    const items = subscription.items?.data || [];
    if (items.length !== 1 || items[0].price?.recurring?.interval !== 'month'
      || items[0].price?.recurring?.interval_count !== 1) {
      return unavailable('A single monthly Stripe billing schedule could not be established.');
    }
    const anchor = timestampDate(subscription.billing_cycle_anchor);
    const periodEnd = timestampDate(subscription.current_period_end ?? items[0].current_period_end);
    const active = ['active', 'trialing'].includes(subscription.status)
      && subscription.collection_method === 'charge_automatically' && !subscription.pause_collection;
    const cancelsBeforeNext = subscription.cancel_at && periodEnd
      && timestampDate(subscription.cancel_at) <= periodEnd;
    return {
      provider: 'stripe',
      regularDay: Number.isInteger(subscription.billing_cycle_anchor_config?.day_of_month)
        && subscription.billing_cycle_anchor_config.day_of_month >= 1
        && subscription.billing_cycle_anchor_config.day_of_month <= 31
        ? subscription.billing_cycle_anchor_config.day_of_month
        : anchor ? Number(anchor.slice(8, 10)) : null,
      // Period end is provider scheduling evidence, not evidence of payment.
      nextConfirmedDate: active && !subscription.cancel_at_period_end && !cancelsBeforeNext
        && periodEnd >= new Date(now).toISOString().slice(0, 10) ? periodEnd : null,
      evidence: 'provider_subscription',
      canEdit: false,
      reason: 'Stripe collection timing is read-only in this feature. Billing dates do not guarantee a successful payment.',
      planId: plan.id, version: null,
    };
  } catch {
    return unavailable('The Stripe schedule could not be verified with the provider.');
  }
}