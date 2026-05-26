/**
 * POST /api/admin/plan-checkout
 *
 * Drives the SaaS-side paid-plan transition for a tenant.
 *
 *   - First-time upgrade (no active Stripe subscription): creates a Stripe
 *     Checkout Session and returns the hosted URL. The webhook flips
 *     tenant.plan_code on `checkout.session.completed` once Stripe reports
 *     the subscription as active.
 *
 *   - Existing active/trialing subscription (plan switch up OR down): updates
 *     the existing Stripe subscription's item price in place with
 *     proration_behavior='create_prorations'. This avoids creating a parallel
 *     second subscription (which would double-bill the customer) and lets the
 *     webhook's `customer.subscription.updated` event carry the new plan_code
 *     into tenant.plan_code.
 *
 * Uses the PLATFORM Stripe account (env `STRIPE_SECRET_KEY`) — not the
 * tenant's own connected Stripe (which is for the tenant's own customers
 * paying them) — since this is the SaaS subscription that iConnect bills the
 * tenant for.
 *
 * Body: { plan_code: 'starter' | 'growth' }
 * Returns:
 *   { url: '<stripe-checkout-url>' }                          // first-time
 *   { switched: true, return_url: '/admin/plan-usage?...' }   // in-place change
 */

import Stripe from 'stripe';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

const APP_DOMAIN = process.env.APP_DOMAIN || 'iconn.app';
const PLATFORM_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing', 'past_due']);

function tenantBaseUrl(tenant) {
  if (tenant?.domain) return `https://${tenant.domain}`;
  if (tenant?.slug) return `https://${tenant.slug}.${APP_DOMAIN}`;
  return process.env.VITE_APP_URL || `https://${APP_DOMAIN}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId || !ctx.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!(await hasAdminAccess(ctx))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!PLATFORM_STRIPE_KEY) {
    return res.status(503).json({ error: 'Plan checkout is not configured (missing STRIPE_SECRET_KEY).' });
  }

  const { plan_code } = req.body || {};
  if (!plan_code || typeof plan_code !== 'string') {
    return res.status(400).json({ error: 'plan_code is required' });
  }

  const { data: plan, error: planError } = await supabase
    .from('plan')
    .select('code, name, stripe_price_id, is_self_serve')
    .eq('code', plan_code)
    .single();
  if (planError || !plan) {
    return res.status(404).json({ error: 'Plan not found' });
  }
  if (!plan.is_self_serve) {
    return res.status(400).json({ error: `The ${plan.name} plan is not available for self-serve upgrade. Please contact us.` });
  }
  if (!plan.stripe_price_id) {
    return res.status(503).json({ error: `The ${plan.name} plan is not configured for checkout yet. Please contact us.` });
  }

  const { data: tenant, error: tenantError } = await supabase
    .from('tenant')
    .select('id, name, slug, domain, plan_code')
    .eq('id', ctx.tenantId)
    .single();
  if (tenantError || !tenant) return res.status(404).json({ error: 'Tenant not found' });

  if (tenant.plan_code === plan.code) {
    return res.status(400).json({ error: `You're already on the ${plan.name} plan.` });
  }

  const stripe = new Stripe(PLATFORM_STRIPE_KEY);

  const { data: existingSub } = await supabase
    .from('tenant_subscription')
    .select('stripe_customer_id, stripe_subscription_id, status')
    .eq('tenant_id', tenant.id)
    .maybeSingle();

  const baseUrl = tenantBaseUrl(tenant);

  // ---------------------------------------------------------------------
  // Plan switch on an existing live subscription: update item price in place
  // ---------------------------------------------------------------------
  if (existingSub?.stripe_subscription_id) {
    let liveSub;
    try {
      liveSub = await stripe.subscriptions.retrieve(existingSub.stripe_subscription_id);
    } catch (err) {
      // Subscription may have been deleted on Stripe; fall through to Checkout below.
      console.warn('[plan-checkout] Could not retrieve existing subscription, falling back to Checkout:', err.message);
      liveSub = null;
    }

    if (liveSub && ACTIVE_SUB_STATUSES.has(liveSub.status) && liveSub.status !== 'canceled') {
      const currentItem = liveSub.items?.data?.[0];
      if (!currentItem) {
        return res.status(500).json({ error: 'Existing subscription has no line items.' });
      }
      if (currentItem.price?.id === plan.stripe_price_id) {
        return res.status(400).json({ error: `Your subscription is already on the ${plan.name} plan.` });
      }

      try {
        await stripe.subscriptions.update(existingSub.stripe_subscription_id, {
          items: [{ id: currentItem.id, price: plan.stripe_price_id }],
          proration_behavior: 'create_prorations',
          cancel_at_period_end: false,
          metadata: {
            tenant_id: tenant.id,
            plan_code: plan.code,
          },
        });
      } catch (err) {
        console.error('[plan-checkout] Stripe subscription update error:', err.message);
        return res.status(502).json({ error: 'Could not switch your plan. Please try again.' });
      }

      // The customer.subscription.updated webhook will (a) keep the
      // tenant_subscription row in sync and (b) flip tenant.plan_code once
      // Stripe confirms the subscription is in a healthy state with the
      // new price. Return early so the client can refresh.
      return res.status(200).json({
        switched: true,
        return_url: `${baseUrl}/admin/plan-usage?upgraded=1`,
      });
    }
    // else: existing row but subscription is canceled / incomplete_expired /
    // missing on Stripe — fall through and start a fresh Checkout.
  }

  // ---------------------------------------------------------------------
  // First-time (or post-cancellation) subscription: hosted Stripe Checkout
  // ---------------------------------------------------------------------
  let billingEmail = null;
  if (ctx.tenantUserId) {
    const { data: tu } = await supabase
      .from('tenant_user')
      .select('email')
      .eq('id', ctx.tenantUserId)
      .maybeSingle();
    billingEmail = tu?.email || null;
  }

  let customerId = existingSub?.stripe_customer_id || null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: billingEmail || undefined,
      name: tenant.name || undefined,
      metadata: { tenant_id: tenant.id, tenant_slug: tenant.slug || '' },
    });
    customerId = customer.id;
  }

  const successUrl = `${baseUrl}/admin/plan-usage?upgraded=1&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/admin/plan-usage?upgrade_cancelled=1`;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      client_reference_id: tenant.id,
      metadata: {
        tenant_id: tenant.id,
        plan_code: plan.code,
      },
      subscription_data: {
        metadata: {
          tenant_id: tenant.id,
          plan_code: plan.code,
        },
      },
    });
  } catch (err) {
    console.error('[plan-checkout] Stripe error:', err.message);
    return res.status(502).json({ error: 'Could not create checkout session. Please try again.' });
  }

  return res.status(200).json({ url: session.url, session_id: session.id });
}
