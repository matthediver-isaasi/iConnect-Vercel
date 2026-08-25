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
import { postStripeInstalmentInvoice } from '../_lib/membershipInstalmentInvoicing.js';
import { getTrustedBaseUrlForTenant } from '../_lib/publicBaseUrl.js';
import { releaseExpiredFormMonthlyCardCheckout } from '../_lib/formMonthlyCardCheckout.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';

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
  const reportHeartbeat = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.stripeCardPlanReconciliation,
  });
  if (!supabase) {
    await reportHeartbeat(false);
    return res.status(500).json({ error: 'Database not configured' });
  }
  credsCache.clear(); // fresh credentials each run (warm serverless containers)
  baseUrlCache.clear(); // fresh base URLs each run

  const startTime = Date.now();
  const results = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };

  try {
    await reconcileFormConflictCompensations(results);
    await reconcileStaleCheckouts(results);
    await reconcileStalePlans(results);
    await retryFailedInstalmentInvoices(results);
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
  await reportHeartbeat(results.errors === 0);
  return res.status(200).json({ ok: true, duration_ms: duration, ...results });
}

async function flagAttention(table, id, reason) {
  const { error } = await supabase
    .from(table)
    .update({ needs_attention: true, attention_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error(`[cron/reconcile-stripe-card-plans] failed to flag ${table}#${id}: ${error.message}`);
}

// One trusted base-URL fetch per tenant per run (caches alongside creds).
const baseUrlCache = new Map();
async function baseUrlFor(tenantId) {
  if (!baseUrlCache.has(tenantId)) {
    baseUrlCache.set(tenantId, await getTrustedBaseUrlForTenant(null, supabase, tenantId).catch(() => ''));
  }
  return baseUrlCache.get(tenantId) || '';
}

// Replay a Stripe event through the shared processor with mode-tolerant client.
// baseUrl is resolved per tenant so form entity pipelines work correctly for
// form-originated checkout sessions (Task #3680).
async function replayEvent(tenantId, event, matchedClient = null) {
  const creds = await credsFor(tenantId);
  const clients = stripeClients(creds);
  const getStripe = async () => matchedClient || clients[0] || null;
  const baseUrl = await baseUrlFor(tenantId);
  return processStripeCardPlanEvent(event, { db: supabase, getStripe, baseUrl });
}

// Form/member resolution can discover a member-year conflict only after the
// subscription Checkout completed. The processor records a durable "pending"
// compensation before touching Stripe; this sweep retries cancellation/refund
// even after webhook retries are exhausted and even when needs_attention=true.
async function reconcileFormConflictCompensations(results) {
  const { data: rows, error } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('provider', 'stripe')
    .filter('metadata->form_conflict_resolution->>status', 'eq', 'pending')
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load pending form conflict compensations failed: ${error.message}`);

  for (const agreement of rows || []) {
    try {
      const subscriptionId = agreement.metadata?.form_conflict_resolution?.subscription_id
        || agreement.stripe_subscription_id
        || null;
      if (!subscriptionId) throw new Error('pending form conflict has no Stripe subscription id');
      const clients = stripeClients(await credsFor(agreement.tenant_id));
      if (clients.length === 0) throw new Error('Stripe credentials unavailable for conflict compensation');
      const { client, result: subscription } = await withModeTolerance(
        clients,
        (candidate) => candidate.subscriptions.retrieve(subscriptionId),
      );
      if (!client || !subscription) throw new Error(`Stripe subscription ${subscriptionId} not found`);
      const outcome = await replayEvent(agreement.tenant_id, {
        id: `reconcile-form-conflict-${agreement.id}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: agreement.stripe_checkout_session_id || `agreement-${agreement.id}`,
            mode: 'subscription',
            status: 'complete',
            subscription: subscriptionId,
            invoice: subscription.latest_invoice || null,
            metadata: {
              kind: CARD_PLAN_KIND,
              agreement_id: agreement.id,
              form_submission_id: agreement.metadata?.form_submission_id || '',
            },
          },
        },
      }, client);
      if (!outcome?.conflict || !outcome?.handled) {
        throw new Error(outcome?.detail || 'conflict compensation did not complete');
      }
      results.repaired++;
      results.details.push({ agreement: agreement.id, repaired: outcome.detail });
    } catch (err) {
      results.errors++;
      await flagAttention(
        'membership_billing_agreements',
        agreement.id,
        `Membership conflict cleanup pending: ${err.message}`,
      );
      results.details.push({ agreement: agreement.id, error: err.message });
    }
  }
}

async function resetExpiredFormCheckout(agreement) {
  const released = await releaseExpiredFormMonthlyCardCheckout(supabase, {
    agreementId: agreement.id,
    checkoutSessionId: agreement.stripe_checkout_session_id,
  });
  if (!released.ok) {
    throw new Error(released.detail || 'expired Checkout reservation was not released');
  }
  return released;
}

// Task #3633 — retry per-instalment accounting invoices that previously
// failed (or were inserted but never attempted). The posting helper is
// idempotent on the row's invoice linkage, so retries can never duplicate.
async function retryFailedInstalmentInvoices(results) {
  let rows = null;
  try {
    const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    const { data, error } = await supabase
      .from('membership_instalment_invoices')
      .select('*')
      .eq('provider', 'stripe')
      .or(`accounting_sync_status.in.(failed,pending,invoice_unpaid),and(accounting_sync_status.eq.posting,updated_at.lt.${staleCutoff})`)
      .order('updated_at', { ascending: true })
      .limit(MAX_ROWS_PER_GROUP);
    if (error) {
      // Pre-migration — nothing to retry.
      if (error.code === '42P01') return;
      throw new Error(`load failed instalment invoices failed: ${error.message}`);
    }
    rows = data;
  } catch (err) {
    results.errors++;
    results.details.push({ error: err.message });
    return;
  }

  for (const row of rows || []) {
    try {
      const { data: agreement } = await supabase
        .from('membership_billing_agreements')
        .select('*')
        .eq('id', row.billing_agreement_id)
        .maybeSingle();
      if (!agreement) { results.skipped++; continue; }
      const outcome = await postStripeInstalmentInvoice({
        agreement,
        plan: row.plan_id ? { id: row.plan_id } : null,
        stripeInvoiceId: row.external_payment_id,
        amountMinor: row.amount_minor,
        currency: row.currency,
      }, { reclaimStale: true });
      if (outcome.status === 'posted') {
        results.repaired++;
        results.details.push({ instalmentInvoice: row.id, repaired: 'per-instalment invoice posted on retry' });
      } else {
        results.skipped++;
        if (outcome.status === 'failed') {
          results.details.push({ instalmentInvoice: row.id, error: `retry failed: ${outcome.reason}` });
        }
      }
    } catch (err) {
      results.errors++;
      results.details.push({ instalmentInvoice: row.id, error: err.message });
    }
  }
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
      const { client, result: session } = await withModeTolerance(clients, (c) =>
        c.checkout.sessions.retrieve(agreement.stripe_checkout_session_id));
      if (!session) { results.skipped++; continue; }

      if (session.status === 'complete') {
        // Missed webhook — replay the checkout completion through the processor.
        const outcome = await replayEvent(agreement.tenant_id, {
          id: `reconcile-checkout-${session.id}`,
          type: 'checkout.session.completed',
          data: { object: { ...session, metadata: { ...(session.metadata || {}), kind: CARD_PLAN_KIND, agreement_id: agreement.id } } },
        }, client);
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
        // payment_setup_required -> payment_setup_required is intentionally a
        // no-op transition, but the expired provider link still must be
        // cleared so the next attempt creates a fresh Checkout.
        await resetExpiredFormCheckout(agreement);
        results.repaired++;
        if (!outcome.applied && outcome.skippedReason !== 'no-change') {
          results.details.push({ agreement: agreement.id, warning: outcome.skippedReason });
        }
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
        }, client);
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
