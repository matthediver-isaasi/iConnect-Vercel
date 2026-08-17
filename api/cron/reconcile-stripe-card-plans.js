// Task #3620 — Stripe monthly card plan reconciliation safety-net cron.
//
// Catches webhook misses for monthly membership card plans:
//   1. Agreements stuck pending checkout too long → re-fetch the Checkout
//      session; roll forward a completed session (missed webhook) or reset
//      an expired one back to payment_setup_required.
//   2. Stale active/pending stripe plans → re-fetch the subscription's paid
//      invoices and replay any instalments missed locally (synthetic
//      invoice.paid events through the same processor: progression,
//      completion, guarded settle + workflow all stay exactly-once).
//   3. Plans whose subscription was cancelled remotely without completing →
//      repair local status / flag for attention.
//
// Live/test mode-flip tolerant: each lookup tries the tenant's current-mode
// key first, then the other key on resource_missing.
//
// Guarded by CRON_SECRET; logs a scheduled_task_log row per run.

import Stripe from 'stripe';
import { supabase } from '../_lib/database.js';
import { getStripeIntegrationCredentials } from '../_lib/stripeCredentials.js';
import { applyStatusTransition, STATUS } from '../_lib/gocardlessState.js';
import {
  processStripeCardPlanEvent,
  CARD_PLAN_KIND,
  cardPlanNeedsSettlement,
  settleCardPlanCompletion,
} from '../_lib/stripeMonthlyCard.js';

const CHECKOUT_PENDING_STALE_HOURS = 6;
const PLAN_STALE_DAYS = 2;
const MAX_ROWS_PER_GROUP = 100;

function agoIso(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// One credential fetch per tenant per run.
const credsCache = new Map();
async function credsFor(tenantId) {
  if (!credsCache.has(tenantId)) {
    credsCache.set(tenantId, await getStripeIntegrationCredentials(tenantId).catch(() => null));
  }
  return credsCache.get(tenantId);
}

function stripeClients(creds) {
  // [preferred, fallback] by the tenant's current mode; dedupe identical keys.
  const keys = [creds?.secret_key, creds?.test_secret_key].filter(Boolean);
  return [...new Set(keys)].map((k) => new Stripe(k));
}

// Try a Stripe call against each mode's client until one finds the resource.
async function withModeTolerance(clients, fn) {
  let lastErr = null;
  for (const client of clients) {
    try {
      return { client, result: await fn(client) };
    } catch (err) {
      lastErr = err;
      if (err?.code !== 'resource_missing' && err?.statusCode !== 404) throw err;
    }
  }
  if (lastErr) throw lastErr;
  return { client: null, result: null };
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reconcile-stripe-card-plans] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  credsCache.clear(); // fresh credentials each run (warm serverless containers)

  const startTime = Date.now();
  const results = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };

  try {
    await reconcileStaleCheckouts(results);
    await reconcileStalePlans(results);
  } catch (err) {
    console.error('[cron/reconcile-stripe-card-plans] fatal:', err);
    results.errors++;
    results.details.push({ error: err.message });
  }

  const duration = Date.now() - startTime;
  try {
    const { error } = await supabase.from('scheduled_task_log').insert({
      tenant_id: null,
      task_name: 'stripe_card_plan_reconciliation',
      task_display_name: 'Stripe Card Plan Reconciliation',
      status: results.errors > 0 ? 'partial' : 'success',
      details: JSON.stringify({ ...results, duration_ms: duration }),
      executed_at: new Date().toISOString(),
    });
    if (error) console.error('[cron/reconcile-stripe-card-plans] failed to log run:', error.message);
  } catch (logErr) {
    console.error('[cron/reconcile-stripe-card-plans] failed to log run:', logErr.message);
  }

  console.log(`[cron/reconcile-stripe-card-plans] done in ${duration}ms: repaired=${results.repaired} flagged=${results.flagged} errors=${results.errors}`);
  return res.status(200).json({ ok: true, duration_ms: duration, ...results });
}

async function flagAttention(table, id, reason) {
  const { error } = await supabase
    .from(table)
    .update({ needs_attention: true, attention_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error(`[cron/reconcile-stripe-card-plans] failed to flag ${table}#${id}: ${error.message}`);
}

// Replay a Stripe event through the shared processor with mode-tolerant client.
async function replayEvent(tenantId, event) {
  const creds = await credsFor(tenantId);
  const clients = stripeClients(creds);
  const getStripe = async () => clients[0] || null;
  return processStripeCardPlanEvent(event, { db: supabase, getStripe, baseUrl: '' });
}

// Group 1 — agreements stuck pending checkout.
async function reconcileStaleCheckouts(results) {
  const { data: rows, error } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('provider', 'stripe')
    .in('status', [STATUS.MANDATE_PENDING, STATUS.PAYMENT_SETUP_REQUIRED])
    .eq('needs_attention', false)
    .not('stripe_checkout_session_id', 'is', null)
    .lt('updated_at', agoIso(CHECKOUT_PENDING_STALE_HOURS * 3_600_000))
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load stale card agreements failed: ${error.message}`);

  for (const agreement of rows || []) {
    try {
      const creds = await credsFor(agreement.tenant_id);
      const clients = stripeClients(creds);
      if (clients.length === 0) { results.skipped++; continue; }
      const { result: session } = await withModeTolerance(clients, (c) =>
        c.checkout.sessions.retrieve(agreement.stripe_checkout_session_id));
      if (!session) { results.skipped++; continue; }

      if (session.status === 'complete') {
        // Missed webhook — replay the checkout completion through the processor.
        const outcome = await replayEvent(agreement.tenant_id, {
          id: `reconcile-checkout-${session.id}`,
          type: 'checkout.session.completed',
          data: { object: { ...session, metadata: { ...(session.metadata || {}), kind: CARD_PLAN_KIND, agreement_id: agreement.id } } },
        });
        results.repaired++;
        results.details.push({ agreement: agreement.id, repaired: outcome.detail });
      } else if (session.status === 'expired') {
        const outcome = await applyStatusTransition({
          entityType: 'billing_agreement',
          entityId: agreement.id,
          toStatus: STATUS.PAYMENT_SETUP_REQUIRED,
          reason: 'reconciliation: checkout session expired',
          source: 'reconciliation',
        });
        if (outcome.applied) results.repaired++;
        else results.skipped++;
      } else {
        // Still open after the stale window — the member may just be slow;
        // flag only after a much longer window (2 days).
        if (new Date(agreement.updated_at) < new Date(agoIso(2 * 86_400_000))) {
          await flagAttention('membership_billing_agreements', agreement.id,
            `Checkout session ${agreement.stripe_checkout_session_id} still '${session.status}' after 2+ days`);
          results.flagged++;
        } else {
          results.skipped++;
        }
      }
    } catch (err) {
      results.errors++;
      results.details.push({ agreement: agreement.id, error: err.message });
    }
  }
}

// Groups 2+3 — stale plans: replay missed paid invoices; repair remote cancels.
async function reconcileStalePlans(results) {
  const { data: rows, error } = await supabase
    .from('membership_payment_plans')
    .select('*')
    .eq('provider', 'stripe')
    .not('stripe_subscription_id', 'is', null)
    .in('status', [STATUS.FIRST_PAYMENT_PENDING, STATUS.ACTIVE, STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE])
    .lt('updated_at', agoIso(PLAN_STALE_DAYS * 86_400_000))
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load stale card plans failed: ${error.message}`);

  for (const plan of rows || []) {
    try {
      const creds = await credsFor(plan.tenant_id);
      const clients = stripeClients(creds);
      if (clients.length === 0) { results.skipped++; continue; }

      // Interrupted completion: all instalments counted but settlement never
      // finished (history unpaid / subscription still active). Repair BEFORE
      // invoice replay — those invoices are already recorded as paid, so
      // replay alone would dedupe them and never settle.
      if (cardPlanNeedsSettlement(plan)) {
        const { data: agreement, error: agErr } = await supabase
          .from('membership_billing_agreements')
          .select('*')
          .eq('id', plan.billing_agreement_id)
          .maybeSingle();
        if (agErr) throw new Error(`load agreement for settlement repair failed: ${agErr.message}`);
        if (agreement) {
          const settled = await settleCardPlanCompletion({
            // Pass ALL mode clients: conclusion is only confirmed if the
            // subscription is cancelled/missing in EVERY mode (mode-flip safe).
            plan, agreement, stripe: clients, eventId: `reconcile-settle-${plan.id}`,
          });
          results.repaired++;
          results.details.push({ plan: plan.id, repaired: `resumed interrupted completion settlement (workflow=${settled.workflowFired})` });
          continue;
        }
      }

      const { client, result: sub } = await withModeTolerance(clients, (c) =>
        c.subscriptions.retrieve(plan.stripe_subscription_id));
      if (!sub) {
        await flagAttention('membership_payment_plans', plan.id,
          `Stripe subscription ${plan.stripe_subscription_id} not found in either mode`);
        results.flagged++;
        continue;
      }

      // Replay any paid invoices we missed (dedupe via metadata.paid_invoice_ids
      // inside the processor keeps this exactly-once).
      const paidIds = Array.isArray(plan.metadata?.paid_invoice_ids) ? plan.metadata.paid_invoice_ids : [];
      const invoices = await client.invoices.list({ subscription: plan.stripe_subscription_id, status: 'paid', limit: 100 });
      let replayed = 0;
      for (const inv of invoices?.data || []) {
        if (paidIds.includes(inv.id)) continue;
        const outcome = await replayEvent(plan.tenant_id, {
          id: `reconcile-invoice-${inv.id}`,
          type: 'invoice.paid',
          data: { object: { ...inv, subscription: plan.stripe_subscription_id } },
        });
        if (outcome.handled) replayed++;
      }
      if (replayed > 0) {
        results.repaired++;
        results.details.push({ plan: plan.id, repaired: `replayed ${replayed} missed paid invoice(s)` });
        continue;
      }

      // No missed payments; repair remote cancellation drift. A subscription
      // we cancelled ourselves at completion moves the plan out of the
      // statuses selected above, so a cancel seen here is a true drift.
      if (sub.status === 'canceled') {
        const outcome = await applyStatusTransition({
          entityType: 'payment_plan',
          entityId: plan.id,
          toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
          reason: 'reconciliation: stripe subscription cancelled remotely',
          source: 'reconciliation',
        });
        if (outcome.applied) results.repaired++;
        else results.skipped++;
      } else {
        results.skipped++;
      }
    } catch (err) {
      results.errors++;
      results.details.push({ plan: plan.id, error: err.message });
    }
  }
}
