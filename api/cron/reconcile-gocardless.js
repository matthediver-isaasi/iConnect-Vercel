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
import { postDdInstalmentToAccounting } from '../_lib/gocardlessAccounting.js';
import { isPerInstalmentAgreement } from '../_lib/membershipInstalmentInvoicing.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';
import { processGocardlessEvent } from '../_lib/gocardlessWebhookProcessor.js';

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
const CONFIRMED_OBLIGATION_STALE_MINUTES = 15;
const MAX_ROWS_PER_GROUP = 100;

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function executeReconciliation(_req, res) {
  const reportHeartbeat = createHeartbeatReporter({
    envVar: HEARTBEAT_ENV_VARS.gocardlessReconciliation,
  });
  if (!supabase) {
    await reportHeartbeat(false);
    return res.status(500).json({ error: 'Database not configured' });
  }
  clientCache.clear(); // fresh credentials each run (warm serverless containers)

  const startTime = Date.now();
  const results = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };

  try {
    await reconcileStaleAgreements(results);
    await reconcilePlansWithoutSubscription(results);
    await reconcileSubscriptionDrift(results);
    await reconcileStalePayments(results);
    await retryFailedInstalmentInvoices(results);
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
  await reportHeartbeat(results.errors === 0);
  return res.status(200).json({ ok: true, duration_ms: duration, ...results });
}

export function createReconcileGocardlessHandler({
  execute = executeReconciliation,
} = {}) {
  return async function handler(req, res) {
    const authHeader = req.headers.authorization;
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      console.error('[cron/reconcile-gocardless] CRON_SECRET is not configured');
      return res.status(503).json({ error: 'Cron authentication is not configured' });
    }
    if (authHeader !== `Bearer ${cronSecret}`) {
      console.log('[cron/reconcile-gocardless] Unauthorized request');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return execute(req, res);
  };
}

const handler = createReconcileGocardlessHandler();
export default handler;

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
        const mandate = await gc.getMandate(mandateId);
        if (['active', 'reinstated'].includes(mandate?.status)) {
          // Replay only once the provider says collection is possible. This
          // durably attaches identity, creates the one idempotent finite
          // subscription from immutable terms, and resumes interrupted
          // initial-payment finalisation. A genuinely pending Bacs mandate
          // remains pending and must never be hastened locally.
          const outcome = await processGocardlessEvent({
            id: `reconcile:billing-request:${agreement.gocardless_billing_request_id}`,
            resource_type: 'billing_requests',
            action: 'fulfilled',
            links: {
              billing_request: agreement.gocardless_billing_request_id,
              mandate_request_mandate: mandateId,
              customer: br?.links?.customer || agreement.gocardless_customer_id || null,
              payment_request_payment: br?.links?.payment_request_payment || null,
            },
          }, { db: supabase, gc });
          if (!outcome.handled || outcome.retryable) {
            throw new Error(outcome.detail || 'fulfilled billing request reconciliation was not handled');
          }
          results.repaired++;
          results.details.push({
            agreement: agreement.id,
            repaired: `fulfilled replay (mandate ${mandate.status})`,
          });
        } else {
          const customerId = br?.links?.customer || null;
          if (agreement.gocardless_mandate_id && agreement.gocardless_mandate_id !== mandateId) {
            throw new Error('reconciliation mandate conflicts with existing agreement identity');
          }
          if (customerId && agreement.gocardless_customer_id
            && agreement.gocardless_customer_id !== customerId) {
            throw new Error('reconciliation customer conflicts with existing agreement identity');
          }
          const identityUpdate = {
            ...(!agreement.gocardless_mandate_id ? { gocardless_mandate_id: mandateId } : {}),
            ...(!agreement.gocardless_customer_id && customerId
              ? { gocardless_customer_id: customerId }
              : {}),
          };
          if (Object.keys(identityUpdate).length > 0) {
            const { error: identityError } = await supabase
              .from('membership_billing_agreements')
              .update({ ...identityUpdate, updated_at: new Date().toISOString() })
              .eq('id', agreement.id)
              .eq('tenant_id', agreement.tenant_id);
            if (identityError) throw new Error(`repair pending mandate identity failed: ${identityError.message}`);
            results.repaired++;
            results.details.push({ agreement: agreement.id, repaired: 'pending mandate identity attached' });
          } else {
            results.skipped++;
          }
        }
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
async function hasUnfinishedConfirmedPaymentObligations(payment, db) {
  if (!payment.plan_id) return false;
  const { data: plan, error: planError } = await db
    .from('membership_payment_plans')
    .select('*')
    .eq('id', payment.plan_id)
    .eq('tenant_id', payment.tenant_id)
    .maybeSingle();
  if (planError) throw new Error(`load confirmed payment plan failed: ${planError.message}`);
  if (!plan?.billing_agreement_id) return false;
  const { data: agreement, error: agreementError } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('id', plan.billing_agreement_id)
    .eq('tenant_id', payment.tenant_id)
    .maybeSingle();
  if (agreementError) throw new Error(`load confirmed payment agreement failed: ${agreementError.message}`);
  if (agreement?.metadata?.dd?.kind !== 'monthly_direct_debit') return false;
  if ([STATUS.EXPIRED, STATUS.PAYMENT_PLAN_CANCELLED].includes(plan.status)
    || [STATUS.EXPIRED, STATUS.PAYMENT_PLAN_CANCELLED].includes(agreement.status)) {
    return false;
  }

  if ([STATUS.MANDATE_PENDING, STATUS.FIRST_PAYMENT_PENDING].includes(plan.status)
    || [STATUS.MANDATE_PENDING, STATUS.FIRST_PAYMENT_PENDING].includes(agreement.status)
    || (agreement.metadata?.gocardless_initial_payment?.id === payment.gocardless_payment_id
      && !agreement.metadata.gocardless_initial_payment.finalized_at)) {
    return true;
  }
  const historyTable = agreement.member_id
    ? 'member_membership_history'
    : (agreement.organization_id ? 'organisation_membership_history' : null);
  if (historyTable) {
    const { data: history, error: historyError } = await db
      .from(historyTable)
      .select('status, payment_status')
      .eq('billing_agreement_id', agreement.id)
      .maybeSingle();
    if (historyError) throw new Error(`load confirmed payment membership progress failed: ${historyError.message}`);
    const activationIncomplete = agreement.metadata.dd.activation_rule !== 'manual'
      && history && history.status !== 'active';
    const progressIncomplete = history
      && !['partial', 'paid'].includes(history.payment_status);
    if (activationIncomplete || progressIncomplete) return true;
  }
  // Per-instalment posting has its own durable payment-row claim and provider
  // idempotency key, so a missing claim is safe to resume. Annual application
  // is deliberately excluded because replay after an unknown provider result
  // could double-apply it.
  return isPerInstalmentAgreement(agreement) && !payment.accounting_sync_status;
}

async function markPaymentReconciliationFresh(payment, db) {
  // gocardless_payments.updated_at is mirror/reconciliation freshness, not
  // provider lifecycle time. Rotate every examined row behind the cutoff so
  // oldest-first bounded batches cannot permanently starve newer obligations.
  // The original status + timestamp form a CAS: a concurrent webhook wins and
  // this freshness write then matches no row rather than masking new state.
  const { error } = await db
    .from('gocardless_payments')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', payment.id)
    .eq('tenant_id', payment.tenant_id)
    .eq('status', payment.status)
    .eq('updated_at', payment.updated_at);
  if (error) throw new Error(`mark payment reconciliation freshness failed: ${error.message}`);
}

export async function reconcileStalePayments(results, {
  db = supabase,
  gcForTenant = gcFor,
  processEvent = processGocardlessEvent,
} = {}) {
  const { data: pendingRows, error } = await db
    .from('gocardless_payments')
    .select('*')
    .in('status', ['pending_submission', 'submitted'])
    .lt('updated_at', daysAgoIso(PAYMENT_PENDING_STALE_DAYS))
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load stale payments failed: ${error.message}`);
  const confirmedCutoff = new Date(
    Date.now() - CONFIRMED_OBLIGATION_STALE_MINUTES * 60_000,
  ).toISOString();
  const { data: confirmedRows, error: confirmedError } = await db
    .from('gocardless_payments')
    .select('*')
    .in('status', ['confirmed', 'paid_out'])
    .lt('updated_at', confirmedCutoff)
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (confirmedError) throw new Error(`load stale confirmed payment obligations failed: ${confirmedError.message}`);
  const rows = [...(pendingRows || []), ...(confirmedRows || [])];

  for (const payment of rows) {
    try {
      const gc = await gcForTenant(payment.tenant_id);
      const remote = await gc.getPayment(payment.gocardless_payment_id);
      if (!remote?.status) {
        await markPaymentReconciliationFresh(payment, db);
        results.skipped++;
        continue;
      }
      const unchangedConfirmed = ['confirmed', 'paid_out'].includes(payment.status)
        && remote.status === payment.status;
      if (unchangedConfirmed) {
        const unfinished = await hasUnfinishedConfirmedPaymentObligations(payment, db);
        if (!unfinished) {
          await markPaymentReconciliationFresh(payment, db);
          results.skipped++;
          continue;
        }
      } else if (remote.status === payment.status) {
        await markPaymentReconciliationFresh(payment, db);
        results.skipped++;
        continue;
      }
      // paid_out proves confirmation too. Replay confirmed first so a crash
      // after mirror bookkeeping can resume accounting (which intentionally
      // runs only on confirmed), then retain the authoritative paid_out state.
      const action = unchangedConfirmed && remote.status === 'paid_out'
        ? 'confirmed'
        : (remote.status === 'pending_submission' ? 'created' : remote.status);
      const replayable = new Set([
        'created', 'submitted', 'confirmed', 'paid_out', 'failed',
        'cancelled', 'charged_back',
      ]);
      if (replayable.has(action)) {
        // Re-enter the normal lifecycle, not just its status transition.
        // Confirmed retries must resume membership activation, payment
        // progress and idempotent per-instalment accounting after a crash.
        const outcome = await processEvent({
          id: `reconcile:payment:${payment.gocardless_payment_id}:${action}`,
          resource_type: 'payments',
          action,
          links: {
            payment: payment.gocardless_payment_id,
            subscription: remote?.links?.subscription
              || payment.gocardless_subscription_id
              || null,
            mandate: remote?.links?.mandate
              || payment.gocardless_mandate_id
              || null,
            payout: remote?.links?.payout || payment.gocardless_payout_id || null,
          },
        }, { db, gc });
        if (!outcome.handled || outcome.retryable) {
          throw new Error(outcome.detail || `payment ${action} reconciliation was not handled`);
        }
      } else {
        // Keep unknown/new provider states visible without pretending their
        // lifecycle side effects are understood.
        const { error: upErr } = await db
          .from('gocardless_payments')
          .update({ status: remote.status, updated_at: new Date().toISOString() })
          .eq('id', payment.id)
          .eq('tenant_id', payment.tenant_id);
        if (upErr) throw new Error(upErr.message);
      }
      await markPaymentReconciliationFresh(payment, db);
      results.repaired++;
      results.details.push({
        payment: payment.id,
        repaired: unchangedConfirmed
          ? `${payment.status} obligations replayed`
          : `${payment.status} -> ${remote.status}`,
      });
    } catch (err) {
      try {
        await markPaymentReconciliationFresh(payment, db);
      } catch (freshnessError) {
        results.details.push({ payment: payment.id, error: freshnessError.message });
      }
      results.errors++;
      results.details.push({ payment: payment.id, error: err.message });
    }
  }
}

// Task #3633 — retry per-instalment invoice creation for confirmed DD
// payments whose accounting posting previously failed. Only per-instalment
// agreements are retried: their posting is guarded by the payment row's
// invoice linkage so a retry can never mint a duplicate. Annual-mode
// failures (payment application) are NOT auto-retried here, since a failure
// after the provider applied the payment could double-apply.
async function retryFailedInstalmentInvoices(results) {
  // failed → provider call failed; invoice_unpaid → invoice exists but the
  // payment wasn't recorded; stale 'posting' → a crashed in-flight claim
  // (safe to reclaim: provider-side idempotency keys prevent duplicates).
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: rows, error } = await supabase
    .from('gocardless_payments')
    .select('*')
    .or(`accounting_sync_status.in.(failed,invoice_unpaid),and(accounting_sync_status.eq.posting,updated_at.lt.${staleCutoff})`)
    .in('status', ['confirmed', 'paid_out'])
    .order('updated_at', { ascending: true })
    .limit(MAX_ROWS_PER_GROUP);
  if (error) throw new Error(`load failed-sync payments failed: ${error.message}`);

  for (const payment of rows || []) {
    try {
      if (!payment.plan_id) { results.skipped++; continue; }
      const { data: plan } = await supabase
        .from('membership_payment_plans')
        .select('id, billing_agreement_id')
        .eq('id', payment.plan_id)
        .maybeSingle();
      if (!plan?.billing_agreement_id) { results.skipped++; continue; }
      const { data: agreement } = await supabase
        .from('membership_billing_agreements')
        .select('*')
        .eq('id', plan.billing_agreement_id)
        .maybeSingle();
      if (!agreement || !isPerInstalmentAgreement(agreement)) { results.skipped++; continue; }

      const outcome = await postDdInstalmentToAccounting({ agreement, paymentRow: payment }, { reclaimStale: true });
      if (outcome.status === 'posted') {
        results.repaired++;
        results.details.push({ payment: payment.id, repaired: 'per-instalment invoice posted on retry' });
      } else {
        results.skipped++;
        if (outcome.status === 'failed') {
          results.details.push({ payment: payment.id, error: `instalment invoice retry failed: ${outcome.reason}` });
        }
      }
    } catch (err) {
      results.errors++;
      results.details.push({ payment: payment.id, error: err.message });
    }
  }
}
