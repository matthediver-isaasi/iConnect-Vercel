// GoCardless Phase 1 — reconciliation safety-net cron.
//
// Finds stale local state and repairs it from the GoCardless API:
//   1. Agreements stuck in mandate_pending / payment_setup_required too
//      long → re-fetch the billing request and roll forward or reset.
//   2. Plans with an active mandate but no subscription id beyond the
//      grace window → flag for admin attention (never creates payments
//      or subscriptions).
//   3. Plans whose gocardless_subscription_id state disagrees with the
//      API (cancelled/finished remotely) → repair local status.
//   4. Local payments pending beyond the expected settlement window →
//      re-fetch and settle their status.
//
// Guarded by CRON_SECRET; logs a scheduled_task_log row per run.

import { supabase } from '../_lib/database.js';
import { gocardlessForTenant } from '../_lib/gocardless.js';
import { applyStatusTransition, STATUS } from '../_lib/gocardlessState.js';

// Credentials are per tenant (tenant_integrations, env fallback) — cache one
// bound client per tenant_id for the duration of a run.
const clientCache = new Map();
async function gcFor(tenantId) {
  const key = tenantId || '__platform__';
  if (!clientCache.has(key)) clientCache.set(key, await gocardlessForTenant(tenantId || null));
  return clientCache.get(key);
}

const MANDATE_PENDING_STALE_DAYS = 3;
const SETUP_REQUIRED_STALE_DAYS = 7;
const SUBSCRIPTION_MISSING_STALE_DAYS = 2;
const PAYMENT_PENDING_STALE_DAYS = 10;
const MAX_ROWS_PER_GROUP = 100;

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reconcile-gocardless] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(500).json({ error: 'Database not configured' });
  clientCache.clear(); // fresh credentials each run (warm serverless containers)

  const startTime = Date.now();
  const results = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };

  try {
    await reconcileStaleAgreements(results);
    await reconcilePlansWithoutSubscription(results);
    await reconcileSubscriptionDrift(results);
    await reconcileStalePayments(results);
  } catch (err) {
    console.error('[cron/reconcile-gocardless] fatal:', err);
    results.errors++;
    results.details.push({ error: err.message });
  }

  const duration = Date.now() - startTime;
  try {
    const { error } = await supabase.from('scheduled_task_log').insert({
      tenant_id: null,
      task_name: 'gocardless_reconciliation',
      task_display_name: 'GoCardless Reconciliation',
      status: results.errors > 0 ? 'partial' : 'success',
      details: JSON.stringify({ ...results, duration_ms: duration }),
      executed_at: new Date().toISOString(),
    });
    if (error) console.error('[cron/reconcile-gocardless] failed to log run:', error.message);
  } catch (logErr) {
    console.error('[cron/reconcile-gocardless] failed to log run:', logErr.message);
  }

  console.log(`[cron/reconcile-gocardless] done in ${duration}ms: repaired=${results.repaired} flagged=${results.flagged} errors=${results.errors}`);
  return res.status(200).json({ ok: true, duration_ms: duration, ...results });
}

async function flagAttention(table, id, reason) {
  const { error } = await supabase
    .from(table)
    .update({ needs_attention: true, attention_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.error(`[cron/reconcile-gocardless] failed to flag ${table}#${id}: ${error.message}`);
}

// Group 1 — agreements stuck before activation.
async function reconcileStaleAgreements(results) {
  const { data: rows, error } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .in('status', [STATUS.MANDATE_PENDING, STATUS.PAYMENT_SETUP_REQUIRED])
    .eq('needs_attention', false)
    .not('gocardless_billing_request_id', 'is', null)
    .lt('updated_at', daysAgoIso(MANDATE_PENDING_STALE_DAYS))
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load stale agreements failed: ${error.message}`);

  for (const agreement of rows || []) {
    // payment_setup_required rows get a longer window before we look.
    if (agreement.status === STATUS.PAYMENT_SETUP_REQUIRED
      && new Date(agreement.updated_at) > new Date(daysAgoIso(SETUP_REQUIRED_STALE_DAYS))) {
      results.skipped++;
      continue;
    }
    try {
      const gc = await gcFor(agreement.tenant_id);
      const br = await gc.getBillingRequest(agreement.gocardless_billing_request_id);
      const brStatus = br?.status;
      const mandateId = br?.links?.mandate_request_mandate || null;

      if (brStatus === 'fulfilled' && mandateId) {
        // Missed webhook — roll forward.
        const mandate = await gc.getMandate(mandateId);
        const toStatus = mandate?.status === 'active'
          ? STATUS.FIRST_PAYMENT_PENDING
          : STATUS.MANDATE_PENDING;
        const outcome = await applyStatusTransition({
          entityType: 'billing_agreement',
          entityId: agreement.id,
          toStatus,
          reason: `reconciliation: billing request fulfilled (mandate ${mandate?.status})`,
          source: 'reconciliation',
          extraUpdate: { gocardless_mandate_id: mandateId, gocardless_customer_id: br?.links?.customer || agreement.gocardless_customer_id },
        });
        if (outcome.applied) { results.repaired++; results.details.push({ agreement: agreement.id, repaired: `-> ${toStatus}` }); }
        else results.skipped++;
      } else if (brStatus === 'cancelled' || brStatus === 'failed') {
        const outcome = await applyStatusTransition({
          entityType: 'billing_agreement',
          entityId: agreement.id,
          toStatus: STATUS.PAYMENT_SETUP_REQUIRED,
          reason: `reconciliation: billing request ${brStatus}`,
          source: 'reconciliation',
        });
        if (outcome.applied) results.repaired++;
        else results.skipped++;
      } else {
        // Still pending remotely after the stale window — needs a human.
        await flagAttention('membership_billing_agreements', agreement.id,
          `Billing request ${agreement.gocardless_billing_request_id} still '${brStatus}' after ${MANDATE_PENDING_STALE_DAYS}+ days`);
        results.flagged++;
        results.details.push({ agreement: agreement.id, flagged: brStatus });
      }
    } catch (err) {
      results.errors++;
      results.details.push({ agreement: agreement.id, error: err.message });
    }
  }
}

// Group 2 — active mandate but no subscription (Phase 2 creates
// subscriptions; the cron only flags, never creates).
async function reconcilePlansWithoutSubscription(results) {
  const { data: rows, error } = await supabase
    .from('membership_payment_plans')
    .select('*')
    .is('gocardless_subscription_id', null)
    .not('gocardless_mandate_id', 'is', null)
    .in('status', [STATUS.MANDATE_PENDING, STATUS.FIRST_PAYMENT_PENDING])
    .eq('needs_attention', false)
    .lt('updated_at', daysAgoIso(SUBSCRIPTION_MISSING_STALE_DAYS))
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load plans without subscription failed: ${error.message}`);

  for (const plan of rows || []) {
    try {
      const gc = await gcFor(plan.tenant_id);
      const mandate = await gc.getMandate(plan.gocardless_mandate_id);
      if (mandate?.status === 'active') {
        await flagAttention('membership_payment_plans', plan.id,
          `Mandate ${plan.gocardless_mandate_id} active but no subscription created after ${SUBSCRIPTION_MISSING_STALE_DAYS}+ days`);
        results.flagged++;
        results.details.push({ plan: plan.id, flagged: 'active-mandate-no-subscription' });
      } else if (['cancelled', 'failed', 'expired'].includes(mandate?.status)) {
        const outcome = await applyStatusTransition({
          entityType: 'payment_plan',
          entityId: plan.id,
          toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
          reason: `reconciliation: mandate ${mandate.status}`,
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

// Group 3 — subscription state drift.
async function reconcileSubscriptionDrift(results) {
  const { data: rows, error } = await supabase
    .from('membership_payment_plans')
    .select('*')
    .not('gocardless_subscription_id', 'is', null)
    .in('status', [STATUS.FIRST_PAYMENT_PENDING, STATUS.ACTIVE, STATUS.PAYMENT_GRACE_PERIOD, STATUS.PAYMENT_OVERDUE])
    .lt('updated_at', daysAgoIso(1))
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load plans for drift check failed: ${error.message}`);

  for (const plan of rows || []) {
    try {
      const gc = await gcFor(plan.tenant_id);
      const sub = await gc.getSubscription(plan.gocardless_subscription_id);
      if (sub?.status === 'cancelled') {
        const outcome = await applyStatusTransition({
          entityType: 'payment_plan',
          entityId: plan.id,
          toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
          reason: 'reconciliation: subscription cancelled remotely',
          source: 'reconciliation',
        });
        if (outcome.applied) results.repaired++;
        else results.skipped++;
      } else if (sub?.status === 'finished') {
        const outcome = await applyStatusTransition({
          entityType: 'payment_plan',
          entityId: plan.id,
          toStatus: STATUS.EXPIRED,
          reason: 'reconciliation: subscription finished',
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

// Group 4 — payments pending beyond the expected settlement window.
async function reconcileStalePayments(results) {
  const { data: rows, error } = await supabase
    .from('gocardless_payments')
    .select('*')
    .in('status', ['pending_submission', 'submitted'])
    .lt('updated_at', daysAgoIso(PAYMENT_PENDING_STALE_DAYS))
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load stale payments failed: ${error.message}`);

  for (const payment of rows || []) {
    try {
      const gc = await gcFor(payment.tenant_id);
      const remote = await gc.getPayment(payment.gocardless_payment_id);
      if (!remote?.status || remote.status === payment.status) {
        results.skipped++;
        continue;
      }
      const { error: upErr } = await supabase
        .from('gocardless_payments')
        .update({ status: remote.status, updated_at: new Date().toISOString() })
        .eq('id', payment.id);
      if (upErr) throw new Error(upErr.message);
      results.repaired++;
      results.details.push({ payment: payment.id, repaired: `${payment.status} -> ${remote.status}` });

      // Reflect settled outcomes onto the plan.
      if (payment.plan_id) {
        if (['confirmed', 'paid_out'].includes(remote.status)) {
          await applyStatusTransition({
            entityType: 'payment_plan',
            entityId: payment.plan_id,
            toStatus: STATUS.ACTIVE,
            reason: `reconciliation: payment ${remote.status}`,
            source: 'reconciliation',
            extraUpdate: { last_payment_id: payment.gocardless_payment_id, last_payment_status: remote.status, retry_count: 0 },
          });
        } else if (['failed', 'charged_back'].includes(remote.status)) {
          await applyStatusTransition({
            entityType: 'payment_plan',
            entityId: payment.plan_id,
            toStatus: STATUS.PAYMENT_GRACE_PERIOD,
            reason: `reconciliation: payment ${remote.status}`,
            source: 'reconciliation',
            extraUpdate: { last_payment_id: payment.gocardless_payment_id, last_payment_status: remote.status },
          });
        }
      }
    } catch (err) {
      results.errors++;
      results.details.push({ payment: payment.id, error: err.message });
    }
  }
}
