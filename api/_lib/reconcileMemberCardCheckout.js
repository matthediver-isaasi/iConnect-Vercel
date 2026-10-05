import { getStripeIntegrationCredentials } from './stripeCredentials.js';
import { processStripeCardPlanEvent } from './stripeMonthlyCard.js';
import Stripe from 'stripe';

// Browser and webhook use the same processor. Never trust return query flags or
// select today's feature environment for an agreement created in another mode.
export async function reconcileMemberCardCheckout({
  agreement, db, credentials = getStripeIntegrationCredentials,
  makeStripe = key => new Stripe(key), process = processStripeCardPlanEvent,
}) {
  if (!['test', 'live'].includes(agreement.environment)) throw new Error('Original Stripe environment is unavailable');
  const keys = await credentials(agreement.tenant_id);
  const key = agreement.environment === 'test' ? keys?.test_secret_key : keys?.secret_key;
  if (!key) throw new Error('Original Stripe credentials are unavailable');
  const stripe = makeStripe(key);
  const session = await stripe.checkout.sessions.retrieve(agreement.stripe_checkout_session_id);
  if (session.id !== agreement.stripe_checkout_session_id
    || session.metadata?.tenant_id !== agreement.tenant_id
    || session.metadata?.member_id !== agreement.member_id
    || session.livemode !== (agreement.environment === 'live')) {
    throw new Error('Card Checkout identity could not be verified');
  }
  if (session.status !== 'complete') return { confirmed: false };
  const result = await process({
    id: `browser-card-checkout:${session.id}`, type: 'checkout.session.completed', data: { object: session },
  }, { db, getStripe: async () => stripe, expectedTenantId: agreement.tenant_id });
  if (!result.handled || result.retryable || result.blocked) throw new Error('Card setup is awaiting reconciliation');
  return { confirmed: true };
}
