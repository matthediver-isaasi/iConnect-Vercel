/**
 * POST /api/webhooks/stripe-membership?tenant=<uuid>
 *
 * Task #3278 — Stripe webhook safety net for MEMBERSHIP card payments.
 *
 * The membership paid-marking previously relied entirely on a single
 * client-driven `confirm_payment` call after checkout: any confirm-step
 * failure (3DS redirect drop-off, mode flip mid-session, server validation
 * error) silently lost the paid state while the card was charged. This
 * endpoint receives `payment_intent.succeeded` events straight from Stripe
 * and idempotently records the membership payment via the shared
 * reconciliation recorder — a no-op when the client confirm already
 * recorded it (dedupe by PI on the history tables).
 *
 * Per-tenant pattern (mirrors api/webhooks/gocardless.js): each tenant
 * registers this URL with ?tenant=<uuid> on their own Stripe account and
 * stores the endpoint's signing secret in tenant_integrations (stripe)
 * credentials as `membership_webhook_secret` (and, for the test-mode
 * endpoint, `test_membership_webhook_secret`). Signature is verified
 * against the raw body; events are durably deduped into
 * payment_webhook_events; processing failures are logged + stored but
 * still acked with 2xx (the event is durable, retry is manual/scripted).
 *
 * Scope guard: ONLY membership PIs are processed (metadata carries
 * membership_year + member_id|organization_id, i.e. minted by
 * api/public/membership-fees/[token].js or api/forms/membership-payment.js).
 * Event-booking / job-posting / platform-plan PIs are acked and skipped.
 */

import Stripe from 'stripe';
import { supabase } from '../_lib/database.js';
import { getStripeIntegrationCredentials } from '../_lib/stripeCredentials.js';
import { recordSucceededMembershipPaymentIntent } from '../_lib/membershipPaymentReconciliation.js';
import { processStripeCardPlanEvent, CARD_PLAN_KIND } from '../_lib/stripeMonthlyCard.js';
import { capturePaymentIntentBillingAddress } from '../_lib/stripeInvoiceAddress.js';
import {
  CARD_PLAN_EVENT_TYPES,
  classifyStripeMembershipEventTenant,
  selectStripeEventModeCredentials,
} from '../_lib/stripeMembershipWebhookConfig.js';

// Task #3620 — subscription/invoice events for monthly-card membership plans
// are routed to the card-plan processor (same durable dedupe as PIs).
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isMembershipPaymentIntent(pi) {
  const md = pi?.metadata || {};
  if (!md.tenant_id || !md.membership_year) return false;
  if (!md.member_id && !md.organization_id) return false;
  // Exclude other Stripe surfaces defensively (they don't set
  // membership_year, but keep the guard explicit).
  if (md.booking_id || md.job_posting_id) return false;
  return true;
}

export async function handleStripeMembershipWebhook(req, res, dependencies = {}) {
  const db = dependencies.db ?? supabase;
  const StripeClient = dependencies.StripeClient || Stripe;
  const loadCredentials = dependencies.getStripeIntegrationCredentials
    || getStripeIntegrationCredentials;
  const classifyTenant = dependencies.classifyStripeMembershipEventTenant
    || classifyStripeMembershipEventTenant;
  const processCardPlan = dependencies.processStripeCardPlanEvent
    || processStripeCardPlanEvent;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!db) return res.status(503).json({ error: 'Database not configured' });

  const tenantId = typeof req.query?.tenant === 'string' && req.query.tenant ? req.query.tenant : null;
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant query parameter is required' });
  }

  let creds;
  try {
    creds = await loadCredentials(tenantId);
  } catch (err) {
    console.error(`[stripe-membership webhook] credential lookup failed (tenant=${tenantId}): ${err.message}`);
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (!creds?.membership_webhook_secret && !creds?.test_membership_webhook_secret) {
    console.error(`[stripe-membership webhook] no membership_webhook_secret configured for tenant ${tenantId}`);
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Failed to read body' });
  }

  const signature = req.headers['stripe-signature'];
  let unsignedEvent;
  try {
    unsignedEvent = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  const modeCredentials = selectStripeEventModeCredentials(unsignedEvent, creds);
  if (!modeCredentials) {
    return res.status(400).json({ error: 'Webhook event mode is missing' });
  }
  const {
    mode: eventMode,
    signingSecret,
    apiKey: modeApiKey,
  } = modeCredentials;
  if (!signingSecret) {
    return res.status(503).json({ error: `Webhook not configured for ${eventMode} mode` });
  }
  let event;
  try {
    event = StripeClient.webhooks.constructEvent(raw, signature, signingSecret);
  } catch {
    console.error(`[stripe-membership webhook] Invalid signature (tenant=${tenantId})`);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  // Never use the opposite-mode key. Each verified event must be bound to the
  // API account matching its livemode before tenant ownership is evaluated.
  let stripeForEvent = null;
  if (modeApiKey) {
    try {
      stripeForEvent = new StripeClient(modeApiKey);
    } catch {
      return res.status(503).json({
        error: `Stripe API key could not be used for ${eventMode} mode`,
        status: 'pending',
      });
    }
  }
  const ownership = await classifyTenant(event, {
    expectedTenantId: tenantId,
    stripe: stripeForEvent,
  });
  if (ownership.status === 'foreign' || ownership.status === 'irrelevant') {
    return res.status(200).json({ received: true, status: 'skipped' });
  }
  if (ownership.status === 'unknown') {
    return res.status(422).json({ error: ownership.message });
  }
  if (ownership.status === 'unavailable') {
    return res.status(503).json({ error: ownership.message, status: 'pending' });
  }
  if (!modeApiKey) {
    return res.status(503).json({
      error: `Stripe API key is not configured for ${eventMode} mode`,
      status: 'pending',
    });
  }

  // Durable dedupe on (provider, event_id). Duplicate deliveries are NOT
  // blindly acked: a previous delivery may have ended in a RECOVERABLE
  // state ('pending', e.g. webhook arrived before the confirm flow created
  // the history row) — Stripe's retry is our retry loop, so reprocess those.
  const { data: inserted, error: insErr } = await db
    .from('payment_webhook_events')
    .upsert({
      provider: 'stripe-membership',
      event_id: event.id,
      resource_type: event.data?.object?.object || null,
      action: event.type || null,
      resource_id: event.data?.object?.id || null,
      tenant_id: tenantId,
      payload: event,
      processing_status: 'pending',
    }, { onConflict: 'provider,event_id', ignoreDuplicates: true })
    .select('id');

  if (insErr) {
    console.error(`[stripe-membership webhook] failed to log event ${event.id}: ${insErr.message}`);
    // Without a durable log we must not ack — let Stripe retry.
    return res.status(500).json({ error: 'Failed to log event' });
  }

  let rowId = inserted?.[0]?.id || null;
  if (!rowId) {
    const { data: existing } = await db
      .from('payment_webhook_events')
      .select('id, processing_status')
      .eq('provider', 'stripe-membership')
      .eq('event_id', event.id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!existing) {
      // The global provider/event id may belong to a historical row owned by
      // another tenant. Never read, acknowledge, or mutate that row.
      return res.status(409).json({ error: 'Webhook event ownership conflict' });
    }
    if (existing.processing_status === 'processed' || existing.processing_status === 'skipped') {
      return res.status(200).json({ received: true, status: 'duplicate' });
    }
    rowId = existing.id; // recoverable — reprocess this delivery
  }

  const markEvent = async (processing_status, processing_error = null) => {
    const { error } = await db
      .from('payment_webhook_events')
      .update({ processing_status, processing_error, processed_at: new Date().toISOString() })
      .eq('id', rowId)
      .eq('tenant_id', tenantId);
    if (error) console.error(`[stripe-membership webhook] failed to mark event ${event.id}: ${error.message}`);
  };

  const baseUrlForEvent = req.headers.host
    ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
    : '';

  // Monthly-card plan events (Task #3620): subscription-mode checkout,
  // recurring invoice outcomes, subscription conclusion.
  if (CARD_PLAN_EVENT_TYPES.has(event.type)) {
    try {
      const getStripe = async () => {
        return stripeForEvent;
      };
      const outcome = await processCardPlan(event, {
        db,
        getStripe,
        baseUrl: baseUrlForEvent,
        expectedTenantId: tenantId,
      });
      if (outcome.handled) {
        await markEvent('processed');
        return res.status(200).json({ received: true, status: 'processed', detail: outcome.detail });
      }
      // Not ours (e.g. an unrelated subscription product) → skip. But a
      // checkout.session.completed carrying OUR kind that found no local
      // agreement yet is recoverable — keep pending and let Stripe retry.
      const isOurCheckout = event.type === 'checkout.session.completed'
        && event.data?.object?.metadata?.kind === CARD_PLAN_KIND;
      // Same for OUR invoices arriving before the checkout event created the
      // local plan (Stripe does not guarantee cross-event ordering).
      if (isOurCheckout || outcome.retryable) {
        console.error(`[stripe-membership webhook] card-plan event ${event.id} not matched yet: ${outcome.detail} — leaving pending for retry`);
        await markEvent('pending', outcome.detail);
        return res.status(500).json({ received: true, status: 'unmatched', detail: outcome.detail, retry: true });
      }
      await markEvent('skipped', outcome.detail);
      return res.status(200).json({ received: true, status: 'skipped', detail: outcome.detail });
    } catch (err) {
      console.error(`[stripe-membership webhook] card-plan processing failed for ${event.id}: ${err.message}`);
      await markEvent('pending', err.message);
      return res.status(500).json({ received: true, status: 'failed', error: err.message });
    }
  }

  const pi = event.data?.object;
  if (event.type !== 'payment_intent.succeeded' || !isMembershipPaymentIntent(pi)) {
    await markEvent('skipped', `not a membership payment_intent.succeeded (type=${event.type})`);
    return res.status(200).json({ received: true, status: 'skipped' });
  }

  try {
    if (pi.metadata?.source === 'form-membership-payment') {
      await capturePaymentIntentBillingAddress({
        stripe: stripeForEvent,
        paymentIntent: pi,
      });
    }
    const baseUrl = req.headers.host
      ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
      : '';
    const outcome = await recordSucceededMembershipPaymentIntent({
      tenantId,
      paymentIntent: pi,
      baseUrl,
      source: 'stripe_membership_webhook',
    });
    const ok = outcome.status === 'recorded' || outcome.status === 'already-recorded' || outcome.status === 'raced';
    if (ok) {
      await markEvent('processed');
      return res.status(200).json({ received: true, status: outcome.status, detail: outcome.detail || null });
    }
    if (outcome.status === 'invalid') {
      // Malformed/mismatched metadata will never become processable.
      await markEvent('skipped', `invalid: ${outcome.detail || ''}`);
      return res.status(200).json({ received: true, status: 'invalid', detail: outcome.detail || null });
    }
    // Recoverable: 'unmatched' (history row not created yet — confirm flow
    // may still be running) or 'conflict'. Keep the event 'pending' and
    // return 500 so Stripe redelivers with backoff; the reconcile cron and
    // admin script are the backstops after Stripe gives up.
    console.error(`[stripe-membership webhook] PI ${pi.id} not reconciled yet (${outcome.status}): ${outcome.detail} — leaving event pending for retry`);
    await markEvent('pending', `${outcome.status}: ${outcome.detail || ''}`);
    return res.status(500).json({ received: true, status: outcome.status, detail: outcome.detail || null, retry: true });
  } catch (err) {
    console.error(`[stripe-membership webhook] processing failed for ${event.id}: ${err.message}`);
    await markEvent('pending', err.message);
    // Non-2xx: the event stays pending; Stripe retries, then the cron /
    // scripts/reconcile-membership-stripe-payment.mjs can repair.
    return res.status(500).json({ received: true, status: 'failed', error: err.message });
  }
}

export default async function handler(req, res) {
  return handleStripeMembershipWebhook(req, res);
}
