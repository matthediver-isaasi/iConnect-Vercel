/**
 * POST /api/webhooks/stripe-plan
 *
 * Stripe webhook for the SaaS subscription billing (the platform-side Stripe
 * account, configured via `STRIPE_SECRET_KEY` + `STRIPE_PLAN_WEBHOOK_SECRET`).
 * Handles:
 *   - checkout.session.completed       → flip tenant.plan_code, upsert tenant_subscription
 *   - customer.subscription.updated    → keep tenant_subscription in sync
 *   - customer.subscription.deleted    → revert tenant to 'free'
 *
 * Body parsing is disabled so we can verify the Stripe signature against the
 * raw payload.
 */

import Stripe from 'stripe';
import { supabase } from '../_lib/database.js';

export const config = { api: { bodyParser: false } };

const PLATFORM_STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_PLAN_WEBHOOK_SECRET;

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function setTenantPlan(tenantId, planCode) {
  if (!tenantId || !planCode) return;
  await supabase.from('tenant').update({ plan_code: planCode }).eq('id', tenantId);
}

async function upsertSubscription(row) {
  if (!row.tenant_id) return;
  const payload = { ...row, updated_at: new Date().toISOString() };
  await supabase
    .from('tenant_subscription')
    .upsert(payload, { onConflict: 'tenant_id' });
}

async function planExists(code) {
  const { data } = await supabase.from('plan').select('code').eq('code', code).maybeSingle();
  return !!data;
}

async function planCodeForPriceId(priceId) {
  if (!priceId) return null;
  const { data } = await supabase
    .from('plan')
    .select('code')
    .eq('stripe_price_id', priceId)
    .maybeSingle();
  return data?.code || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (!PLATFORM_STRIPE_KEY || !WEBHOOK_SECRET) {
    console.error('[stripe-plan webhook] Missing STRIPE_SECRET_KEY or STRIPE_PLAN_WEBHOOK_SECRET');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const stripe = new Stripe(PLATFORM_STRIPE_KEY);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-plan webhook] Invalid signature:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;
        const tenantId = session.metadata?.tenant_id || session.client_reference_id;
        let planCode = session.metadata?.plan_code;
        const subscriptionId = session.subscription;
        const customerId = session.customer;

        let priceId = null;
        let currentPeriodEnd = null;
        let status = 'active';
        let cancelAtPeriodEnd = false;
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          priceId = sub.items?.data?.[0]?.price?.id || null;
          currentPeriodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
          status = sub.status || 'active';
          cancelAtPeriodEnd = !!sub.cancel_at_period_end;
          if (!planCode) planCode = await planCodeForPriceId(priceId);
        }

        if (tenantId && planCode && (await planExists(planCode))) {
          // Always persist the subscription row so we can recover the link
          // even if payment is still finalising, but only grant the new
          // plan's quotas once Stripe reports a healthy status. Otherwise
          // an `incomplete` / `past_due` / `unpaid` checkout could unlock
          // paid limits before money is collected. The follow-up
          // customer.subscription.updated event will flip plan_code as
          // soon as status transitions to active/trialing.
          if (['active', 'trialing'].includes(status)) {
            await setTenantPlan(tenantId, planCode);
            console.log(`[stripe-plan webhook] tenant=${tenantId} upgraded to plan=${planCode}`);
          } else {
            console.log(`[stripe-plan webhook] tenant=${tenantId} checkout completed but status=${status}; deferring plan flip`);
          }
          await upsertSubscription({
            tenant_id: tenantId,
            plan_code: planCode,
            stripe_customer_id: customerId || null,
            stripe_subscription_id: subscriptionId || null,
            stripe_price_id: priceId,
            status,
            current_period_end: currentPeriodEnd,
            cancel_at_period_end: cancelAtPeriodEnd,
          });
        } else {
          console.warn('[stripe-plan webhook] checkout.session.completed missing tenant_id or plan_code', { tenantId, planCode });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const tenantId = sub.metadata?.tenant_id;
        const priceId = sub.items?.data?.[0]?.price?.id || null;
        const planCode = sub.metadata?.plan_code || (await planCodeForPriceId(priceId));
        if (tenantId && planCode && (await planExists(planCode))) {
          // Only flip tenant.plan_code while the sub is in a "good" state.
          if (['active', 'trialing'].includes(sub.status)) {
            await setTenantPlan(tenantId, planCode);
          }
          await upsertSubscription({
            tenant_id: tenantId,
            plan_code: planCode,
            stripe_customer_id: sub.customer || null,
            stripe_subscription_id: sub.id,
            stripe_price_id: priceId,
            status: sub.status || 'active',
            current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
            cancel_at_period_end: !!sub.cancel_at_period_end,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const tenantId = sub.metadata?.tenant_id;
        if (tenantId) {
          await setTenantPlan(tenantId, 'free');
          await upsertSubscription({
            tenant_id: tenantId,
            plan_code: 'free',
            stripe_customer_id: sub.customer || null,
            stripe_subscription_id: sub.id,
            stripe_price_id: sub.items?.data?.[0]?.price?.id || null,
            status: 'canceled',
            current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
            cancel_at_period_end: !!sub.cancel_at_period_end,
          });
          console.log(`[stripe-plan webhook] tenant=${tenantId} subscription canceled, reverted to free`);
        }
        break;
      }

      default:
        // Ignore other event types
        break;
    }
  } catch (err) {
    console.error('[stripe-plan webhook] handler error:', err);
    return res.status(500).json({ error: 'Webhook handler error' });
  }

  return res.status(200).json({ received: true });
}
