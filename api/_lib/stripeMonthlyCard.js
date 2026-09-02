// Task #3620 — Monthly membership payments by card via Stripe Subscriptions.
//
// Mirrors the GoCardless monthly DD plan model (api/_lib/gocardlessDirectDebit.js):
//
// Pure decision logic (exported for node --test):
//   - resolveCardMonthlyOffer(simResult)   tier config -> monthly-card offer or null
//   - buildCardAgreementSnapshot(...)      immutable terms snapshot at consent
//   - graceDaysForCardAgreement(...)       snapshot grace days (metadata.card)
//   - decideCardActivation(...)            activation rule -> activate?
//   - cardPlanCompletionDecision(...)      instalment bookkeeping for one paid invoice
//
// Impure orchestration (deps-injectable { db, stripe } like the GC processor):
//   - processStripeCardPlanEvent(...)      one Stripe subscription/invoice event
//   - settleCardPlanCompletion(...)        plan done -> history row paid + workflow (once)
//
// Rules (identical to DD):
//   - The agreement snapshot in membership_billing_agreements.metadata.card is
//     written ONCE at consent and never recomputed. Later tier-config edits
//     never change an in-flight agreement.
//   - GC columns stay strictly GC; Stripe identifiers live in stripe_* columns
//     and rows carry provider='stripe'.
//   - Every supabase write's { error } is inspected.

import { supabase } from './database.js';
import { applyStatusTransition, STATUS } from './gocardlessState.js';
import { randomUUID } from 'node:crypto';
import {
  toMinorUnits,
  ACTIVATION_RULES,
  membershipHistoryTableForAgreement,
} from './gocardlessDirectDebit.js';
import {
  computeGraceExpiry,
  recoveryPlanUpdate,
  clearAgreementArrearsFlag,
} from './gocardlessArrears.js';
import { sendDdLifecycleEmail } from './gocardlessDdEmails.js';
import { fireWorkflowForPaidRow } from './membershipPaymentReconciliation.js';
import { isPerInstalmentAgreement, postStripeInstalmentInvoice } from './membershipInstalmentInvoicing.js';
import { finalizeFormMonthlyCardCheckout } from './formMonthlyCardFinalize.js';
import { captureCheckoutBillingAddress } from './stripeInvoiceAddress.js';

export const CARD_PLAN_KIND = 'monthly_card';

/**
 * Given a membership simulation result, decide whether a monthly card
 * (Stripe subscription) option is available and what its terms are.
 * Enabled independently of DD via membership_tier_config.card_monthly_enabled,
 * but the monthly amount / instalment count / activation & grace terms are
 * shared with the DD configuration (dd_monthly_amount etc.).
 * Returns null when not offered (config disabled, no monthly amount, org-scoped).
 */
export function resolveCardMonthlyOffer(simResult) {
  if (!simResult?.success) return null;
  const config = simResult.config;
  if (!config?.card_monthly_enabled) return null;

  let monthlyAmount = null;
  if ((config.pricing_model || 'tiered') === 'flat') {
    monthlyAmount = config.dd_monthly_amount != null ? Number(config.dd_monthly_amount) : null;
  } else {
    const band = simResult.matchedBand;
    monthlyAmount = band?.dd_monthly_amount != null ? Number(band.dd_monthly_amount) : null;
  }
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) return null;

  const instalmentCount = Math.min(12, Math.max(1, parseInt(config.dd_instalment_count, 10) || 12));
  const monthlyAmountMinor = toMinorUnits(monthlyAmount);
  if (!monthlyAmountMinor) return null;

  return {
    monthlyAmount: parseFloat(monthlyAmount.toFixed(2)),
    monthlyAmountMinor,
    instalmentCount,
    planTotal: parseFloat(((monthlyAmountMinor * instalmentCount) / 100).toFixed(2)),
    currency: simResult.currency || config.currency || 'GBP',
    activationRule: ACTIVATION_RULES.includes(config.dd_activation_rule)
      ? config.dd_activation_rule : 'first_payment',
    graceDays: Number.isInteger(config.dd_grace_days) ? config.dd_grace_days : 7,
    termsVersion: config.dd_terms_version || 'v1',
    // Task #3633: shared with DD — 'annual' (default) or 'per_instalment'.
    invoicingMode: config.dd_invoicing_mode === 'per_instalment' ? 'per_instalment' : 'annual',
  };
}

function toDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Immutable terms snapshot stored on the billing agreement at consent
 * (membership_billing_agreements.metadata.card). Everything the webhook
 * path later needs lives here.
 */
export function buildCardAgreementSnapshot({ offer, simResult, acceptedAt = new Date().toISOString() }) {
  if (!offer) throw new Error('offer is required');
  return {
    kind: CARD_PLAN_KIND,
    monthly_amount: offer.monthlyAmount,
    monthly_amount_minor: offer.monthlyAmountMinor,
    instalment_count: offer.instalmentCount,
    plan_total: offer.planTotal,
    currency: offer.currency,
    activation_rule: offer.activationRule,
    grace_days: offer.graceDays,
    terms_version: offer.termsVersion,
    invoicing_mode: offer.invoicingMode === 'per_instalment' ? 'per_instalment' : 'annual',
    accepted_at: acceptedAt,
    membership_year: simResult?.membershipYear?.label || null,
    membership_year_start: simResult?.membershipYear?.start
      ? toDateOnly(simResult.membershipYear.start).toISOString().slice(0, 10) : null,
    config_id: simResult?.config?.id || null,
    band_id: simResult?.matchedBand?.id || null,
    tier_label: simResult?.tierLabel || null,
    field_value: simResult?.fieldValue ?? null,
    annual_cost: simResult?.annualCost ?? null,
    final_cost: simResult?.finalCost ?? null,
    vat_rate_percent: simResult?.vatRatePercent ?? null,
    vat_amount: simResult?.vatAmount ?? 0,
    total_with_vat: simResult?.totalWithVat ?? offer.planTotal,
  };
}

export function isCardAgreement(agreement) {
  return agreement?.provider === 'stripe' || agreement?.metadata?.card?.kind === CARD_PLAN_KIND;
}

/** Snapshot grace days — NEVER live config. Mirrors graceDaysForAgreement. */
export function graceDaysForCardAgreement(agreement) {
  const raw = agreement?.metadata?.card?.grace_days;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), 90);
  return 7;
}

/**
 * Activation semantics for card plans. There is no mandate; the closest
 * analogue to 'mandate' is successful checkout completion (card captured).
 *   - 'mandate':        activate at checkout completion (or first payment)
 *   - 'first_payment':  activate when the first invoice is paid
 *   - 'manual':         never auto-activate
 */
export function decideCardActivation({ activationRule, trigger }) {
  if (activationRule === 'manual') return false;
  if (activationRule === 'mandate') return trigger === 'checkout_complete' || trigger === 'first_payment_confirmed';
  return trigger === 'first_payment_confirmed';
}

/**
 * Pure instalment bookkeeping for one paid invoice.
 * Returns { duplicate } or { duplicate: false, instalmentsPaid, complete, paidInvoiceIds }.
 */
/**
 * True when a plan has counted all its instalments but has NOT been settled
 * yet (no completed_at / EXPIRED status). This is the resumable window: the
 * instalment counter committed but settlement (history paid + workflow +
 * subscription cancel) failed afterwards, so a webhook retry or the reconcile
 * cron must re-run settlement instead of treating the invoice as a duplicate.
 */
export function cardPlanNeedsSettlement(plan) {
  const total = Number(plan?.instalments_total) || 0;
  const paid = Number(plan?.instalments_paid) || 0;
  if (!(total > 0 && paid >= total)) return false;
  if (plan.completed_at) return false;
  if (plan.status === STATUS.EXPIRED) return false;
  return true;
}

export function cardPlanCompletionDecision({ plan, invoiceId }) {
  const paidIds = Array.isArray(plan?.metadata?.paid_invoice_ids) ? plan.metadata.paid_invoice_ids : [];
  if (invoiceId && paidIds.includes(invoiceId)) return { duplicate: true };
  const total = Number(plan?.instalments_total) || 0;
  const instalmentsPaid = (Number(plan?.instalments_paid) || 0) + 1;
  return {
    duplicate: false,
    instalmentsPaid,
    complete: total > 0 && instalmentsPaid >= total,
    paidInvoiceIds: invoiceId ? [...paidIds, invoiceId] : paidIds,
  };
}

const COMPLETION_WORKFLOW_LEASE_MS = 5 * 60 * 1000;

async function claimCompletionWorkflow({ db, plan, agreement, historyTable }) {
  const existing = plan.metadata?.workflow_pending || null;
  const claimedAtMs = existing?.claimed_at ? new Date(existing.claimed_at).getTime() : 0;
  if (existing?.status === 'processing'
      && Number.isFinite(claimedAtMs)
      && Date.now() - claimedAtMs < COMPLETION_WORKFLOW_LEASE_MS) {
    return { claimed: false, pending: true };
  }

  const ownerToken = randomUUID();
  const marker = {
    status: 'processing',
    owner_token: ownerToken,
    claimed_at: new Date().toISOString(),
    table: historyTable,
    agreement_id: agreement.id,
  };
  let query = db
    .from('membership_payment_plans')
    .update({
      metadata: { ...(plan.metadata || {}), workflow_pending: marker },
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id);
  if (!existing) {
    query = query.filter('metadata->workflow_pending', 'is', null);
  } else if (existing.claimed_at) {
    query = query.filter(
      'metadata->workflow_pending->>claimed_at',
      'eq',
      existing.claimed_at,
    );
  } else {
    // Adopt the marker written by releases before owner-token leases existed.
    query = query.filter(
      'metadata->workflow_pending->>agreement_id',
      'eq',
      existing.agreement_id || agreement.id,
    );
  }
  const { data, error } = await query.select('*').maybeSingle();
  if (error) throw new Error(`persist workflow marker failed: ${error.message}`);
  if (!data) return { claimed: false, pending: true };
  return {
    claimed: true,
    ownerToken,
    reclaimed: !!existing,
    plan: data,
  };
}

async function reserveCompletionWorkflowDelivery({
  db,
  plan,
  ownerToken,
  historyTable,
  historyRowId,
}) {
  const deliveryKey = `membership-paid:${historyTable}:${historyRowId}`;
  const priorDelivery = plan.metadata?.workflow_delivery || null;
  if (priorDelivery && priorDelivery.key !== deliveryKey) {
    throw new Error(`workflow delivery key mismatch for payment plan ${plan.id}`);
  }

  // Renew ownership immediately before reserving the side effect. A worker
  // whose lease was reclaimed while it was settling history fails this CAS and
  // can never call triggerWorkflows.
  const renewedMarker = {
    ...(plan.metadata?.workflow_pending || {}),
    claimed_at: new Date().toISOString(),
  };
  const { data: renewed, error: renewErr } = await db
    .from('membership_payment_plans')
    .update({
      metadata: { ...(plan.metadata || {}), workflow_pending: renewedMarker },
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id)
    .filter('metadata->workflow_pending->>owner_token', 'eq', ownerToken)
    .select('*')
    .maybeSingle();
  if (renewErr) throw new Error(`renew workflow settlement lease failed: ${renewErr.message}`);
  if (!renewed) return { owned: false, shouldDispatch: false, plan: null };
  const renewedDelivery = renewed.metadata?.workflow_delivery || priorDelivery;
  if (renewedDelivery?.key === deliveryKey) {
    return {
      owned: true,
      shouldDispatch: renewedDelivery.status !== 'completed',
      deliveryKey,
      plan: renewed,
    };
  }

  // Durable pending marker. The workflow engine accepts the same delivery key
  // and owns retry/deduplication; this plan marker is only completed after that
  // engine confirms dispatch.
  const delivery = {
    key: deliveryKey,
    status: 'pending',
    owner_token: ownerToken,
    reserved_at: new Date().toISOString(),
  };
  const { data: reserved, error: reserveErr } = await db
    .from('membership_payment_plans')
    .update({
      metadata: { ...(renewed.metadata || {}), workflow_delivery: delivery },
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id)
    .filter('metadata->workflow_pending->>owner_token', 'eq', ownerToken)
    .filter('metadata->workflow_delivery', 'is', null)
    .select('*')
    .maybeSingle();
  if (reserveErr) throw new Error(`reserve workflow delivery failed: ${reserveErr.message}`);
  if (!reserved) {
    const { data: latest, error: latestErr } = await db
      .from('membership_payment_plans')
      .select('*')
      .eq('id', plan.id)
      .maybeSingle();
    if (latestErr) throw new Error(`reload workflow delivery failed: ${latestErr.message}`);
    if (latest?.metadata?.workflow_delivery?.key === deliveryKey) {
      return {
        owned: true,
        shouldDispatch: latest.metadata.workflow_delivery.status !== 'completed',
        deliveryKey,
        plan: latest,
      };
    }
    return { owned: false, shouldDispatch: false, plan: latest || null };
  }
  return {
    owned: true,
    shouldDispatch: true,
    deliveryKey,
    plan: reserved,
  };
}

async function completeCompletionWorkflowDelivery({
  db,
  plan,
  ownerToken,
  deliveryKey,
}) {
  const completed = {
    ...(plan.metadata?.workflow_delivery || {}),
    key: deliveryKey,
    status: 'completed',
    completed_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('membership_payment_plans')
    .update({
      metadata: { ...(plan.metadata || {}), workflow_delivery: completed },
      updated_at: new Date().toISOString(),
    })
    .eq('id', plan.id)
    .filter('metadata->workflow_pending->>owner_token', 'eq', ownerToken)
    .filter('metadata->workflow_delivery->>key', 'eq', deliveryKey)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`complete workflow delivery failed: ${error.message}`);
  if (!data) throw new Error('complete workflow delivery failed: settlement ownership was lost');
  return data;
}

// ---------------------------------------------------------------------------
// Impure orchestration
// ---------------------------------------------------------------------------

function defaultDeps(deps) {
  return { db: deps.db || supabase, getStripe: deps.getStripe || null };
}

async function findCardAgreementById(db, agreementId) {
  const { data, error } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('id', agreementId)
    .maybeSingle();
  if (error) throw new Error(`load agreement failed: ${error.message}`);
  return data || null;
}

async function findCardAgreementByCheckoutSession(db, sessionId) {
  const { data, error } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('stripe_checkout_session_id', sessionId)
    .maybeSingle();
  if (error) throw new Error(`load agreement by checkout session failed: ${error.message}`);
  return data || null;
}

async function findCardPlanBySubscription(db, subscriptionId) {
  const { data, error } = await db
    .from('membership_payment_plans')
    .select('*')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();
  if (error) throw new Error(`load plan by stripe subscription failed: ${error.message}`);
  return data || null;
}

/**
 * Apply the snapshot's activation rule to the linked membership-history row.
 * Card twin of activateMembershipForAgreement (which requires metadata.dd).
 */
export async function activateMembershipForCardAgreement(agreement, { trigger, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const snapshot = agreement?.metadata?.card;
  const table = membershipHistoryTableForAgreement(agreement);
  if (!snapshot || !table) return { updated: false, detail: 'no card snapshot or member' };

  const { data: row, error } = await db
    .from(table)
    .select('id, status')
    .eq('billing_agreement_id', agreement.id)
    .maybeSingle();
  if (error) throw new Error(`load membership history for agreement failed: ${error.message}`);
  if (!row) return { updated: false, detail: 'no membership history row linked to agreement' };
  if (row.status === 'active') return { updated: false, detail: 'membership already active' };

  const activate = decideCardActivation({ activationRule: snapshot.activation_rule, trigger });
  const nextStatus = activate ? 'active' : (snapshot.activation_rule === 'manual' ? 'pending_activation' : null);
  if (!nextStatus || nextStatus === row.status) {
    return { updated: false, detail: `no status change for trigger=${trigger} rule=${snapshot.activation_rule}` };
  }
  const { error: upErr } = await db
    .from(table)
    .update({ status: nextStatus })
    .eq('id', row.id)
    .eq('status', row.status);
  if (upErr) throw new Error(`update membership history failed: ${upErr.message}`);
  return { updated: true, activated: nextStatus === 'active', detail: `membership history -> ${nextStatus} (trigger=${trigger})` };
}

/** First confirmed instalment -> payment_status 'partial' (same as DD). */
export async function recordCardPaymentProgress(agreement, { db: dbArg } = {}) {
  const db = dbArg || supabase;
  const table = membershipHistoryTableForAgreement(agreement);
  if (!table) return { updated: false };
  const { data: row } = await db
    .from(table)
    .select('id, payment_status')
    .eq('billing_agreement_id', agreement.id)
    .maybeSingle();
  if (!row || row.payment_status === 'paid' || row.payment_status === 'partial') {
    return { updated: false };
  }
  const { error } = await db
    .from(table)
    .update({ payment_status: 'partial' })
    .eq('id', row.id);
  if (error) throw new Error(`update payment_status failed: ${error.message}`);
  return { updated: true };
}

async function progressCardPlanAfterPaidInvoice({
  plan,
  agreement,
  instalmentsPaid,
  eventId,
  db,
}) {
  const recoveredFromArrears = plan.status === STATUS.PAYMENT_GRACE_PERIOD
    || plan.status === STATUS.PAYMENT_OVERDUE
    || !!plan.arrears_policy_applied
    || !!agreement?.metadata?.dd?.arrears_state;
  // The first invoice may also be the final invoice (a supported one-instalment
  // plan). Always run first-payment progression before completion settlement,
  // and make it safe to replay if the counter committed but a later step failed.
  await applyStatusTransition({
    entityType: 'payment_plan',
    entityId: plan.id,
    toStatus: STATUS.ACTIVE,
    reason: `card invoice paid (instalment ${instalmentsPaid})`,
    source: 'webhook',
    eventId,
    extraUpdate: recoveryPlanUpdate(),
  }, { db });
  if (agreement.status !== STATUS.ACTIVE) {
    await applyStatusTransition({
      entityType: 'billing_agreement',
      entityId: agreement.id,
      toStatus: STATUS.ACTIVE,
      reason: 'card first payment confirmed',
      source: 'webhook',
      eventId,
    }, { db });
  }
  const activation = await activateMembershipForCardAgreement(
    agreement,
    { trigger: 'first_payment_confirmed', db },
  );
  await recordCardPaymentProgress(agreement, { db });
  if (agreement?.metadata?.dd?.arrears_state) {
    await clearAgreementArrearsFlag(agreement, { db });
  }
  if (recoveredFromArrears) {
    await sendDdLifecycleEmail('payment_recovered', agreement, { db });
  }
  return activation;
}

/**
 * All instalments collected — durable, resumable settlement.
 *
 * Ordering matters: the plan is only moved to its TERMINAL state
 * (expired + completed_at) AFTER every obligation is durably complete:
 *   1. history row settled as paid (guarded flip; DB errors THROW so the
 *      caller retries — the plan stays "fully counted but unsettled" and
 *      cardPlanNeedsSettlement keeps routing retries here),
 *   2. membership-paid workflow fired (a metadata.workflow_pending marker is
 *      persisted BEFORE the paid flip so a crash between flip and workflow is
 *      recoverable; workflow errors THROW with the marker still set),
 *   3. Stripe subscription confirmed concluded (cancelled / already gone).
 *      If cancellation cannot be confirmed we return WITHOUT the terminal
 *      transition, so retries/reconciliation keep attempting it. New
 *      subscriptions also carry a Stripe-side cancel_at boundary, so even a
 *      persistent cancel failure cannot charge past the agreed instalments.
 */
export async function settleCardPlanCompletion({ plan, agreement, stripe = null, baseUrl = '', eventId = null, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const historyTable = membershipHistoryTableForAgreement(agreement);
  let workflowFired = false;

  if (historyTable) {
    const workflowClaim = await claimCompletionWorkflow({
      db,
      plan,
      agreement,
      historyTable,
    });
    if (!workflowClaim.claimed) {
      // Another handler owns workflow delivery. It must clear its token before
      // any caller can cancel/terminalize the plan, otherwise the obligation
      // could be lost while the owner is still dispatching it.
      return {
        transition: { applied: false, skippedReason: 'workflow-settlement-in-progress' },
        workflowFired: false,
        concluded: false,
      };
    }

    // Guarded settle: only the write that actually flips unpaid->paid owns
    // the workflow (exactly-once, mirrors the reconciliation recorder).
    const { data: settled, error: payErr } = await db
      .from(historyTable)
      .update({ payment_status: 'paid', paid_at: new Date().toISOString() })
      .eq('billing_agreement_id', agreement.id)
      .neq('payment_status', 'paid')
      .select('*');
    if (payErr) throw new Error(`mark membership paid failed: ${payErr.message}`);

    let rowForWorkflow = settled?.length ? settled[0] : null;
    if (!rowForWorkflow) {
      const { data: row, error: rowErr } = await db
        .from(historyTable)
        .select('*')
        .eq('billing_agreement_id', agreement.id)
        .maybeSingle();
      if (rowErr) throw new Error(`reload settled history row failed: ${rowErr.message}`);
      if (!row) {
        // A charged, completed plan MUST have a linked history row settled as
        // paid. Its absence is a retryable failure — keep the marker, never
        // terminalize on top of it.
        throw new Error(`membership history row missing for agreement ${agreement.id} — settlement retryable`);
      }
      if (workflowClaim.reclaimed) {
        // We flipped it on a previous attempt but the workflow never confirmed.
        rowForWorkflow = row;
      }
      // Otherwise the row was settled by another path (e.g. the reconcile
      // recorder), which owns the workflow — nothing owed here.
    }

    if (rowForWorkflow) {
      const delivery = await reserveCompletionWorkflowDelivery({
        db,
        plan: workflowClaim.plan || plan,
        ownerToken: workflowClaim.ownerToken,
        historyTable,
        historyRowId: rowForWorkflow.id,
      });
      if (!delivery.owned) {
        return {
          transition: { applied: false, skippedReason: 'workflow-settlement-ownership-lost' },
          workflowFired: false,
          concluded: false,
        };
      }
      workflowClaim.plan = delivery.plan || workflowClaim.plan;
      if (delivery.shouldDispatch) {
        try {
          await fireWorkflowForPaidRow({
            table: historyTable,
            row: rowForWorkflow,
            snapshot: { payment_status: 'unpaid' },
            baseUrl,
            source: 'stripe_monthly_card_completion',
            deliveryKey: delivery.deliveryKey,
          }, { db });
        } catch (err) {
          const { error: attentionErr } = await db
            .from('membership_payment_plans')
            .update({
              needs_attention: true,
              attention_reason: `Membership-paid workflow delivery requires review before retry: ${err.message}`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', plan.id);
          if (attentionErr) {
            console.error('[StripeCard] Failed to flag ambiguous workflow delivery:', attentionErr.message);
          }
          throw err;
        }
        workflowFired = true;
        workflowClaim.plan = await completeCompletionWorkflowDelivery({
          db,
          plan: workflowClaim.plan,
          ownerToken: workflowClaim.ownerToken,
          deliveryKey: delivery.deliveryKey,
        });
      }
    }

    const { data: clearedOwner, error: clrErr } = await db
      .from('membership_payment_plans')
      .update({
        metadata: { ...(workflowClaim.plan?.metadata || plan.metadata || {}), workflow_pending: null },
        updated_at: new Date().toISOString(),
      })
      .eq('id', plan.id)
      .filter('metadata->workflow_pending->>owner_token', 'eq', workflowClaim.ownerToken)
      .select('id')
      .maybeSingle();
    if (clrErr) throw new Error(`clear workflow marker failed: ${clrErr.message}`);
    if (!clearedOwner) throw new Error('clear workflow marker failed: settlement ownership was lost');
  }

  // Conclude the Stripe subscription; only a CONFIRMED conclusion unlocks the
  // terminal transition. `stripe` may be a single client (webhook — the key
  // already matches the event's livemode) or an ARRAY of clients (reconcile —
  // mode-flip tolerance: "missing" only counts once it is missing in EVERY
  // mode, so an alternate-mode subscription is never terminalized unseen).
  const isMissing = (err) => err?.code === 'resource_missing' || err?.statusCode === 404;
  const clientList = Array.isArray(stripe) ? stripe.filter(Boolean) : (stripe ? [stripe] : []);
  let concluded = !plan.stripe_subscription_id;
  if (!concluded && clientList.length > 0) {
    let missingEverywhere = true;
    for (const client of clientList) {
      if (concluded) break;
      try {
        await client.subscriptions.cancel(plan.stripe_subscription_id, {
          cancellation_details: { comment: 'Membership instalment plan complete' },
        });
        concluded = true;
        missingEverywhere = false;
      } catch (err) {
        if (isMissing(err)) continue; // not in this mode — try the next client
        missingEverywhere = false;
        try {
          const sub = await client.subscriptions.retrieve(plan.stripe_subscription_id);
          if (sub?.status === 'canceled') concluded = true;
        } catch (e2) {
          if (isMissing(e2)) continue;
        }
        if (!concluded) {
          console.warn('[StripeCard] subscription cancel after completion failed (will retry):', err.message);
        }
      }
    }
    if (!concluded && missingEverywhere) concluded = true; // gone in every mode
  }
  if (!concluded) {
    // Not terminal yet: cardPlanNeedsSettlement stays true, so webhook
    // retries and the reconcile cron keep resuming from here.
    return {
      transition: { applied: false, skippedReason: 'subscription-not-concluded' },
      workflowFired,
      concluded: false,
    };
  }

  const transition = await applyStatusTransition({
    entityType: 'payment_plan',
    entityId: plan.id,
    toStatus: STATUS.EXPIRED,
    reason: 'card plan completed (all instalments paid)',
    source: 'webhook',
    eventId,
    extraUpdate: {
      completed_at: new Date().toISOString(),
      needs_attention: false,
      attention_reason: null,
    },
  }, { db });

  return { transition, workflowFired, concluded: true };
}

/** Payment failure -> grace/overdue using SNAPSHOT grace days (DD parity). */
export async function handleCardPaymentFailure({ plan, agreement, eventId = null, action = 'failed', db: dbArg } = {}) {
  const db = dbArg || supabase;
  const now = new Date();
  const retryCount = (plan.retry_count || 0) + 1;
  const graceDays = graceDaysForCardAgreement(agreement);

  let graceExpiresAt = plan.grace_expires_at ? new Date(plan.grace_expires_at) : null;
  if (!graceExpiresAt || Number.isNaN(graceExpiresAt.getTime())) {
    graceExpiresAt = computeGraceExpiry(now, graceDays, plan.grace_extended_days || 0);
  }
  const overdue = graceExpiresAt.getTime() <= now.getTime() || plan.status === STATUS.PAYMENT_OVERDUE;
  const toStatus = overdue ? STATUS.PAYMENT_OVERDUE : STATUS.PAYMENT_GRACE_PERIOD;

  const result = await applyStatusTransition({
    entityType: 'payment_plan',
    entityId: plan.id,
    toStatus,
    reason: `card payment ${action} (failure #${retryCount}, grace ${graceDays}d from snapshot)`,
    source: 'webhook',
    eventId,
    extraUpdate: { retry_count: retryCount, grace_expires_at: graceExpiresAt.toISOString() },
  }, { db });

  if (!result.applied) {
    const { error } = await db
      .from('membership_payment_plans')
      .update({ retry_count: retryCount, grace_expires_at: graceExpiresAt.toISOString(), updated_at: now.toISOString() })
      .eq('id', plan.id);
    if (error) console.error('[StripeCard] failure bookkeeping update failed:', error.message);
  }
  return { toStatus, result, graceExpiresAt: graceExpiresAt.toISOString(), retryCount };
}

/**
 * Ensure the local plan row exists for a completed checkout session and the
 * agreement carries the Stripe identifiers. Idempotent (unique index on
 * stripe_subscription_id + idempotency_key re-entry).
 */
export async function ensureCardPlanForCheckout({ agreement, session, db: dbArg } = {}) {
  const db = dbArg || supabase;
  const snapshot = agreement?.metadata?.card;
  if (!snapshot || snapshot.kind !== CARD_PLAN_KIND) {
    return { created: false, plan: null, detail: 'agreement has no card snapshot' };
  }
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (!subscriptionId) return { created: false, plan: null, detail: 'checkout session has no subscription' };

  // Attach Stripe ids onto the agreement (idempotent overwrite-with-same).
  const { error: agreeUpErr } = await db
    .from('membership_billing_agreements')
    .update({
      stripe_subscription_id: subscriptionId,
      stripe_customer_id: customerId || agreement.stripe_customer_id || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', agreement.id);
  if (agreeUpErr) throw new Error(`attach stripe ids to agreement failed: ${agreeUpErr.message}`);

  const existing = await findCardPlanBySubscription(db, subscriptionId);
  if (existing) return { created: false, plan: existing, detail: 'plan already exists' };

  const idempotencyKey = `card-sub:${agreement.id}:${snapshot.membership_year || 'year'}`;
  const insertRow = {
    tenant_id: agreement.tenant_id,
    billing_agreement_id: agreement.id,
    member_id: agreement.member_id || null,
    organization_id: agreement.organization_id || null,
    provider: 'stripe',
    stripe_subscription_id: subscriptionId,
    stripe_customer_id: customerId || null,
    amount_minor: snapshot.monthly_amount_minor,
    currency: snapshot.currency || 'GBP',
    interval_unit: 'monthly',
    status: STATUS.FIRST_PAYMENT_PENDING,
    membership_year: snapshot.membership_year,
    instalments_total: snapshot.instalment_count,
    instalments_paid: 0,
    idempotency_key: idempotencyKey,
    environment: agreement.environment || 'live',
    metadata: { source: 'stripe_monthly_card', agreement_id: agreement.id, paid_invoice_ids: [] },
  };
  const { data: inserted, error: insErr } = await db
    .from('membership_payment_plans')
    .insert(insertRow)
    .select()
    .single();
  if (insErr) {
    if (insErr.code === '23505') {
      const raced = await findCardPlanBySubscription(db, subscriptionId);
      if (raced) return { created: false, plan: raced, detail: 'plan created concurrently' };
      const { data: byKey } = await db
        .from('membership_payment_plans')
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (byKey) return { created: false, plan: byKey, detail: 'plan created concurrently (idempotency key)' };
    }
    throw new Error(`insert card payment plan failed: ${insErr.message}`);
  }
  return { created: true, plan: inserted, detail: `plan created for subscription ${subscriptionId}` };
}

/**
 * A form Checkout may resolve to an existing member only after Stripe has
 * collected the first instalment. If that member already has this membership
 * year (or another open plan), cancel the subscription and refund the first
 * invoice instead of creating a duplicate local plan. Stripe idempotency makes
 * this safe across webhook, browser-confirm, and cron retries.
 */
export async function compensateFormMonthlyCardConflict({
  agreement,
  session,
  detail,
  db: dbArg,
  stripe,
} = {}) {
  const db = dbArg || supabase;
  if (!agreement?.id || !stripe) throw new Error('agreement and stripe client are required');
  const formSubmissionId = agreement.metadata?.form_submission_id
    || session?.metadata?.form_submission_id
    || null;
  const subscriptionId = typeof session?.subscription === 'string'
    ? session.subscription
    : session?.subscription?.id;
  if (!subscriptionId) throw new Error('conflicting checkout has no subscription');
  const conflictMetadata = {
    ...(agreement.metadata || {}),
    form_conflict_resolution: {
      ...(agreement.metadata?.form_conflict_resolution || {}),
      status: 'pending',
      detail: detail || agreement.metadata?.form_conflict_resolution?.detail || null,
      subscription_id: subscriptionId,
      last_attempt_at: new Date().toISOString(),
    },
  };

  try {
    const { error: pendingErr } = await db
      .from('membership_billing_agreements')
      .update({ metadata: conflictMetadata, updated_at: new Date().toISOString() })
      .eq('id', agreement.id);
    if (pendingErr) {
      throw new Error(`persist conflict compensation state failed: ${pendingErr.message}`);
    }

    let subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const invoiceRef = session?.invoice || subscription?.latest_invoice || null;
    if (subscription?.status !== 'canceled') {
      subscription = await stripe.subscriptions.cancel(subscriptionId, { prorate: false });
    }

    const invoiceId = typeof invoiceRef === 'string' ? invoiceRef : invoiceRef?.id;
    let invoice = typeof invoiceRef === 'object' && invoiceRef ? invoiceRef : null;
    if (invoiceId && (!invoice || invoice.amount_paid == null)) {
      invoice = await stripe.invoices.retrieve(invoiceId);
    }
    const amountPaid = Number(invoice?.amount_paid || 0);
    let refundId = null;
    if (amountPaid > 0) {
      const paymentIntentId = typeof invoice?.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice?.payment_intent?.id;
      if (!paymentIntentId) {
        throw new Error(`paid invoice ${invoiceId || '(unknown)'} has no refundable payment intent`);
      }
      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        reason: 'requested_by_customer',
        metadata: {
          kind: 'form_monthly_card_membership_conflict',
          agreement_id: agreement.id,
          form_submission_id: formSubmissionId || '',
        },
      }, { idempotencyKey: `form-card-conflict-refund:${agreement.id}` });
      refundId = refund?.id || null;
    } else if (!invoiceId && session?.payment_status === 'paid') {
      throw new Error('paid conflicting checkout has no invoice to refund');
    }

    let submissionMeta = {};
    if (formSubmissionId) {
      const { data: formRow, error: formReadErr } = await db
        .from('form_submission')
        .select('payment_meta')
        .eq('id', formSubmissionId)
        .maybeSingle();
      if (formReadErr) throw new Error(`load conflicting form submission failed: ${formReadErr.message}`);
      submissionMeta = formRow?.payment_meta || {};
      const { error: formUpdateErr } = await db
        .from('form_submission')
        .update({
          payment_status: 'failed',
          payment_meta: {
            ...submissionMeta,
            monthly_card_state: {
              status: 'conflict_refunded',
              resolved_at: new Date().toISOString(),
              refund_id: refundId,
            },
          },
          processing_notes: `${detail || 'Membership for this year is already recorded'}. The duplicate Stripe subscription was cancelled${refundId ? ' and its payment refunded' : ' before a payment was taken'}.`,
        })
        .eq('id', formSubmissionId);
      if (formUpdateErr) throw new Error(`save conflicting form submission failed: ${formUpdateErr.message}`);
    }

    const { error: agreementUpdateErr } = await db
      .from('membership_billing_agreements')
      .update({
        status: STATUS.PAYMENT_PLAN_CANCELLED,
        stripe_subscription_id: subscriptionId,
        needs_attention: false,
        attention_reason: null,
        metadata: {
          ...conflictMetadata,
          form_conflict_resolution: {
            ...conflictMetadata.form_conflict_resolution,
            status: 'resolved',
            resolved_at: new Date().toISOString(),
            refund_id: refundId,
            detail: detail || null,
          },
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', agreement.id);
    if (agreementUpdateErr) throw new Error(`save conflict resolution failed: ${agreementUpdateErr.message}`);

    return {
      handled: true,
      conflict: true,
      refunded: !!refundId,
      refundId,
      detail: refundId
        ? 'Existing membership detected; duplicate subscription cancelled and first payment refunded'
        : 'Existing membership detected; duplicate subscription cancelled before payment',
    };
  } catch (err) {
    try {
      await db
        .from('membership_billing_agreements')
        .update({
          needs_attention: true,
          attention_reason: `Membership conflict cleanup pending: ${err.message}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', agreement.id);
    } catch {}
    throw err;
  }
}

/**
 * Does this invoice belong to one of OUR monthly-card subscriptions?
 * Checks the metadata Stripe echoes on the invoice payload first, then (if
 * inconclusive) retrieves the subscription. Used to keep out-of-order
 * invoice events (invoice.paid delivered before checkout.session.completed)
 * pending/retryable instead of terminally skipped.
 */
export async function invoiceBelongsToCardPlan(object, subscriptionId, { getStripe } = {}) {
  const payloadKind = object?.subscription_details?.metadata?.kind
    || object?.parent?.subscription_details?.metadata?.kind
    || object?.lines?.data?.[0]?.metadata?.kind
    || null;
  if (payloadKind) return payloadKind === CARD_PLAN_KIND;
  if (typeof getStripe !== 'function') return false;
  try {
    const stripe = await getStripe();
    if (!stripe) return false;
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    return sub?.metadata?.kind === CARD_PLAN_KIND;
  } catch {
    return false;
  }
}

/**
 * Process one Stripe event for the monthly-card membership plans.
 * Returns { handled: boolean, detail: string }. Throws on hard failures
 * (caller keeps the durable event row pending for retry).
 *
 * deps: { db, getStripe: async () => Stripe|null, baseUrl }
 */
export async function processStripeCardPlanEvent(event, deps = {}) {
  const { db, getStripe } = defaultDeps(deps);
  const baseUrl = deps.baseUrl || '';
  const type = event.type;
  const object = event.data?.object || {};

  if (type === 'checkout.session.completed') {
    if (object.mode !== 'subscription' || object.metadata?.kind !== CARD_PLAN_KIND) {
      return { handled: false, detail: 'not a membership monthly-card checkout session' };
    }
    let agreement = await findCardAgreementByCheckoutSession(db, object.id);
    if (!agreement && object.metadata?.agreement_id) {
      agreement = await findCardAgreementById(db, object.metadata.agreement_id);
    }
    if (!agreement) return { handled: false, detail: `no agreement for checkout session ${object.id}` };
    // Task #3680: if this checkout was initiated from a form submission
    // (agreement.metadata.form_submission_id is set), finalize the form
    // BEFORE creating the payment plan. This marks the submission as
    // setup_complete, runs entity pipelines (creates the member record),
    // attaches member_id to the agreement, and creates the membership history
    // row with monthly_card / unpaid semantics. If the member cannot be
    // resolved yet the event is left retryable so Stripe redelivers.
    const isFormCheckout = !!(
      agreement.metadata?.form_submission_id
      || object.metadata?.form_submission_id
    );
    if (isFormCheckout) {
      const conflictResolution = agreement.metadata?.form_conflict_resolution;
      if (conflictResolution?.status === 'pending') {
        const stripe = await getStripe();
        return compensateFormMonthlyCardConflict({
          agreement,
          session: object,
          detail: conflictResolution.detail,
          db,
          stripe,
        });
      }
      if (conflictResolution?.status === 'resolved') {
        return {
          handled: true,
          conflict: true,
          refunded: !!conflictResolution.refund_id,
          detail: 'Existing membership conflict was already reversed',
        };
      }
    }

    if (!agreement.metadata?.card?.billing_address) {
      const stripe = await getStripe();
      const billingAddress = await captureCheckoutBillingAddress({ stripe, session: object });
      const nextMetadata = {
        ...(agreement.metadata || {}),
        card: { ...(agreement.metadata?.card || {}), billing_address: billingAddress },
      };
      const { error: addressSaveErr } = await db
        .from('membership_billing_agreements')
        .update({ metadata: nextMetadata, updated_at: new Date().toISOString() })
        .eq('id', agreement.id);
      if (addressSaveErr) {
        throw new Error(`persist Stripe billing address snapshot failed: ${addressSaveErr.message}`);
      }
      agreement = { ...agreement, metadata: nextMetadata };
      const formSubmissionId = agreement.metadata?.form_submission_id
        || object.metadata?.form_submission_id;
      if (formSubmissionId) {
        const { data: formRow, error: formReadErr } = await db
          .from('form_submission')
          .select('payment_meta')
          .eq('id', formSubmissionId)
          .maybeSingle();
        if (formReadErr) throw new Error(`load form payment address context failed: ${formReadErr.message}`);
        const { error: formSaveErr } = await db
          .from('form_submission')
          .update({
            payment_meta: {
              ...(formRow?.payment_meta || {}),
              stripe_billing_address: billingAddress,
            },
          })
          .eq('id', formSubmissionId);
        if (formSaveErr) throw new Error(`persist form Stripe billing address snapshot failed: ${formSaveErr.message}`);
      }
    }

    if (isFormCheckout) {
      const formResult = await finalizeFormMonthlyCardCheckout({
        db,
        agreement,
        session: object,
        baseUrl,
      });
      if (formResult.conflict) {
        const stripe = await getStripe();
        return compensateFormMonthlyCardConflict({
          agreement,
          session: object,
          detail: formResult.detail,
          db,
          stripe,
        });
      }
      if (!formResult.handled) {
        // Never create a detached plan for a form-backed checkout. Even a
        // terminal-looking form mismatch needs durable operator attention,
        // rather than losing the paid subscription's member/history link.
        return {
          handled: false,
          retryable: formResult.retryable !== false,
          code: formResult.code,
          detail: `form checkout not yet finalizable: ${formResult.detail}`,
        };
      }
      // Re-load the agreement in case member_id was just attached.
      const refreshed = await findCardAgreementById(db, agreement.id);
      if (refreshed) agreement = refreshed;
    }

    const ensured = await ensureCardPlanForCheckout({ agreement, session: object, db });
    await applyStatusTransition({
      entityType: 'billing_agreement',
      entityId: agreement.id,
      toStatus: STATUS.FIRST_PAYMENT_PENDING,
      reason: 'card checkout completed',
      source: 'webhook',
      eventId: event.id,
    }, { db });
    const fresh = await findCardAgreementById(db, agreement.id);
    const activation = await activateMembershipForCardAgreement(fresh || agreement, { trigger: 'checkout_complete', db });
    return { handled: true, detail: `checkout completed: ${ensured.detail}; activation: ${activation.detail}` };
  }

  if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
    const subscriptionId = typeof object.subscription === 'string'
      ? object.subscription
      : (object.subscription?.id || object.parent?.subscription_details?.subscription || null);
    if (!subscriptionId) return { handled: false, detail: 'invoice has no subscription' };
    let plan = await findCardPlanBySubscription(db, subscriptionId);
    if (!plan) {
      // Stripe does not order invoice.paid after checkout.session.completed.
      // If this invoice belongs to OUR subscription kind but the local plan
      // hasn't been created yet, flag it retryable so the webhook keeps the
      // event pending (Stripe redelivers) instead of terminally skipping it.
      const ours = await invoiceBelongsToCardPlan(object, subscriptionId, { getStripe });
      return {
        handled: false,
        retryable: ours,
        detail: `no local card plan for subscription ${subscriptionId}${ours ? ' (ours — awaiting checkout event)' : ''}`,
      };
    }
    if (plan.provider !== 'stripe') return { handled: false, detail: 'plan is not a stripe plan' };
    const agreement = plan.billing_agreement_id ? await findCardAgreementById(db, plan.billing_agreement_id) : null;
    if (!agreement) return { handled: false, detail: 'plan has no billing agreement' };

    // Zero-amount invoices (proration artefacts) don't advance instalments.
    if (Number(object.amount_paid) === 0 && Number(object.amount_due) === 0) {
      return { handled: true, detail: 'zero-amount invoice ignored' };
    }

    // Task #3633: per-instalment invoicing mode — mint one small paid
    // accounting invoice for THIS Stripe invoice. Runs BEFORE the duplicate
    // check so webhook redelivery / reconcile replays retry a failed posting;
    // the helper is idempotent (unique key + invoice-linkage guard) so an
    // already-posted instalment is never minted twice. Best-effort: the
    // posting records its own posted/failed status and never blocks the
    // instalment bookkeeping below.
    if (isPerInstalmentAgreement(agreement)) {
      try {
        const postFn = deps.postInstalmentInvoice || postStripeInstalmentInvoice;
        await postFn({
          agreement,
          plan,
          stripeInvoiceId: object.id,
          amountMinor: Number.isInteger(object.amount_paid) ? object.amount_paid : null,
          currency: (object.currency || '').toUpperCase() || null,
        }, { db, getProvider: deps.getProvider });
      } catch (err) {
        console.error('[StripeCard] per-instalment invoice posting threw:', err.message);
      }
    }

    // Idempotent instalment advance: CAS on instalments_paid + invoice-id dedupe.
    let decision = cardPlanCompletionDecision({ plan, invoiceId: object.id });
    if (decision.duplicate) {
      // Resumable completion: the counter committed on a previous attempt but
      // settlement failed afterwards — retry settlement, don't exit silently.
      if (cardPlanNeedsSettlement(plan)) {
        await progressCardPlanAfterPaidInvoice({
          plan,
          agreement,
          instalmentsPaid: plan.instalments_paid,
          eventId: event.id,
          db,
        });
        const stripe = getStripe ? await getStripe() : null;
        const settled = await settleCardPlanCompletion({ plan, agreement, stripe, baseUrl, eventId: event.id, db });
        return { handled: true, detail: `invoice ${object.id} already counted; settlement resumed (workflow=${settled.workflowFired})` };
      }
      return { handled: true, detail: `invoice ${object.id} already counted` };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data: updated, error: casErr } = await db
        .from('membership_payment_plans')
        .update({
          instalments_paid: decision.instalmentsPaid,
          last_payment_id: object.id,
          last_payment_status: 'paid',
          last_payment_at: new Date().toISOString(),
          metadata: { ...(plan.metadata || {}), paid_invoice_ids: decision.paidInvoiceIds },
          updated_at: new Date().toISOString(),
        })
        .eq('id', plan.id)
        .eq('instalments_paid', plan.instalments_paid ?? 0)
        .select();
      if (casErr) throw new Error(`advance instalments failed: ${casErr.message}`);
      if (updated?.length) { plan = updated[0]; break; }
      // Lost the race — refetch and re-decide (may now be a duplicate).
      plan = await findCardPlanBySubscription(db, subscriptionId);
      if (!plan) return { handled: false, detail: 'plan disappeared during instalment advance' };
      decision = cardPlanCompletionDecision({ plan, invoiceId: object.id });
      if (decision.duplicate) {
        if (cardPlanNeedsSettlement(plan)) {
          await progressCardPlanAfterPaidInvoice({
            plan,
            agreement,
            instalmentsPaid: plan.instalments_paid,
            eventId: event.id,
            db,
          });
          const stripe = getStripe ? await getStripe() : null;
          const settled = await settleCardPlanCompletion({ plan, agreement, stripe, baseUrl, eventId: event.id, db });
          return { handled: true, detail: `invoice ${object.id} already counted (race); settlement resumed (workflow=${settled.workflowFired})` };
        }
        return { handled: true, detail: `invoice ${object.id} already counted (race)` };
      }
      if (attempt === 1) throw new Error('instalment advance CAS failed twice');
    }

    if (decision.complete) {
      await progressCardPlanAfterPaidInvoice({
        plan,
        agreement,
        instalmentsPaid: decision.instalmentsPaid,
        eventId: event.id,
        db,
      });
      const stripe = getStripe ? await getStripe() : null;
      const settled = await settleCardPlanCompletion({ plan, agreement, stripe, baseUrl, eventId: event.id, db });
      return { handled: true, detail: `instalment ${decision.instalmentsPaid}/${plan.instalments_total} paid; plan complete (workflow=${settled.workflowFired})` };
    }

    const activation = await progressCardPlanAfterPaidInvoice({
      plan,
      agreement,
      instalmentsPaid: decision.instalmentsPaid,
      eventId: event.id,
      db,
    });
    return { handled: true, detail: `instalment ${decision.instalmentsPaid}/${plan.instalments_total} paid; activation: ${activation.detail}` };
  }

  if (type === 'invoice.payment_failed') {
    const subscriptionId = typeof object.subscription === 'string'
      ? object.subscription
      : (object.subscription?.id || object.parent?.subscription_details?.subscription || null);
    if (!subscriptionId) return { handled: false, detail: 'invoice has no subscription' };
    const plan = await findCardPlanBySubscription(db, subscriptionId);
    if (!plan) {
      const ours = await invoiceBelongsToCardPlan(object, subscriptionId, { getStripe });
      return {
        handled: false,
        retryable: ours,
        detail: `no local card plan for subscription ${subscriptionId}${ours ? ' (ours — awaiting checkout event)' : ''}`,
      };
    }
    const agreement = plan.billing_agreement_id ? await findCardAgreementById(db, plan.billing_agreement_id) : null;
    const failure = await handleCardPaymentFailure({ plan, agreement, eventId: event.id, action: 'failed', db });
    if (failure.result.applied && agreement?.metadata?.card?.kind === CARD_PLAN_KIND) {
      await sendDdLifecycleEmail(
        failure.toStatus === STATUS.PAYMENT_OVERDUE ? 'payment_overdue' : 'card_payment_failed',
        agreement,
        { db },
      );
    }
    return { handled: true, detail: `card payment failed -> ${failure.toStatus} (grace expires ${failure.graceExpiresAt})` };
  }

  if (type === 'customer.subscription.deleted') {
    const plan = await findCardPlanBySubscription(db, object.id);
    if (!plan) return { handled: false, detail: `no local card plan for subscription ${object.id}` };
    if (plan.completed_at || plan.status === STATUS.EXPIRED) {
      return { handled: true, detail: 'subscription concluded after plan completion — no-op' };
    }
    const result = await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
      reason: 'stripe subscription deleted before completion',
      source: 'webhook',
      eventId: event.id,
    }, { db });
    return { handled: true, detail: `subscription deleted: ${JSON.stringify(result)}` };
  }

  return { handled: false, detail: `unhandled event type ${type}` };
}
