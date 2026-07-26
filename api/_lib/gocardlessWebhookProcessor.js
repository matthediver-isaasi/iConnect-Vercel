// GoCardless Phase 1 — idempotent webhook event processor.
//
// Given a single GoCardless event (already durably logged in
// payment_webhook_events by the webhook endpoint), map it onto local
// mandate / billing-agreement / plan / payment state.
//
// Design rules:
//   - Idempotent: re-processing the same event is a no-op (status
//     transitions refuse duplicates; mandate/payment mirrors are upserts).
//   - Out-of-order tolerant: applyStatusTransition rejects regressions.
//   - Destructive membership changes (cancellation, chargeback handling)
//     re-fetch the current resource from the API before acting, so a
//     stale/late event can never cancel a plan that GoCardless says is
//     healthy.
//   - Every supabase write's { error } is inspected.
//
// Dependencies are injectable for tests: { db, gc } where gc mirrors the
// service-module getters used here.

import { supabase } from './database.js';
import * as gocardless from './gocardless.js';
import { applyStatusTransition, STATUS } from './gocardlessState.js';
import {
  ensureSubscriptionForAgreement,
  activateMembershipForAgreement,
  recordDdPaymentProgress,
  membershipHistoryTableForAgreement,
} from './gocardlessDirectDebit.js';
import { markInvitationCompletedForAgreement } from './gocardlessDdInvitations.js';
import { sendDdLifecycleEmail } from './gocardlessDdEmails.js';

// Emails are best-effort: they must never fail the event (which would mark
// it 'failed' and trigger redelivery/reprocessing of a correct state change).
async function safeDdEmail(eventKey, agreement, opts) {
  try {
    return await sendDdLifecycleEmail(eventKey, agreement, opts);
  } catch (err) {
    console.error(`[GC Webhook] DD email ${eventKey} failed:`, err.message);
    return { sent: false };
  }
}

function defaultDeps(deps) {
  return {
    db: deps.db || supabase,
    gc: deps.gc || gocardless,
  };
}

async function checkedUpsert(db, table, payload, onConflict) {
  const { error } = await db.from(table).upsert(payload, { onConflict });
  if (error) throw new Error(`upsert ${table} failed: ${error.message}`);
}

async function findAgreementByBillingRequest(db, billingRequestId) {
  const { data, error } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('gocardless_billing_request_id', billingRequestId)
    .maybeSingle();
  if (error) throw new Error(`load agreement by billing request failed: ${error.message}`);
  return data || null;
}

async function findAgreementById(db, agreementId) {
  const { data, error } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('id', agreementId)
    .maybeSingle();
  if (error) throw new Error(`load agreement by id failed: ${error.message}`);
  return data || null;
}

async function findAgreementByMandate(db, mandateId) {
  const { data, error } = await db
    .from('membership_billing_agreements')
    .select('*')
    .eq('gocardless_mandate_id', mandateId)
    .maybeSingle();
  if (error) throw new Error(`load agreement by mandate failed: ${error.message}`);
  return data || null;
}

async function findPlanBySubscription(db, subscriptionId) {
  const { data, error } = await db
    .from('membership_payment_plans')
    .select('*')
    .eq('gocardless_subscription_id', subscriptionId)
    .maybeSingle();
  if (error) throw new Error(`load plan by subscription failed: ${error.message}`);
  return data || null;
}

async function findPlansByMandate(db, mandateId) {
  const { data, error } = await db
    .from('membership_payment_plans')
    .select('*')
    .eq('gocardless_mandate_id', mandateId);
  if (error) throw new Error(`load plans by mandate failed: ${error.message}`);
  return data || [];
}

/**
 * Process one GoCardless event. Returns
 *   { handled: boolean, detail: string }
 * Throws on hard failures (caller marks the event row 'failed').
 */
export async function processGocardlessEvent(event, deps = {}) {
  const { db, gc } = defaultDeps(deps);
  const resourceType = event.resource_type;
  const action = event.action;
  const links = event.links || {};

  switch (resourceType) {
    case 'billing_requests':
      return processBillingRequestEvent({ event, action, links, db, gc });
    case 'mandates':
      return processMandateEvent({ event, action, links, db, gc });
    case 'subscriptions':
      return processSubscriptionEvent({ event, action, links, db, gc });
    case 'payments':
      return processPaymentEvent({ event, action, links, db, gc });
    default:
      return { handled: false, detail: `ignored resource_type=${resourceType}` };
  }
}

// ---------------------------------------------------------------------------

async function processBillingRequestEvent({ event, action, links, db, gc }) {
  const brId = links.billing_request;
  if (!brId) return { handled: false, detail: 'no billing_request link' };
  const agreement = await findAgreementByBillingRequest(db, brId);
  if (!agreement) return { handled: false, detail: `no local agreement for billing request ${brId}` };

  if (action === 'fulfilled') {
    // Mandate (and possibly customer) now exist. Attach them.
    const extraUpdate = {};
    let mandateId = links.mandate_request_mandate || null;
    let customerId = links.customer || null;
    if (!mandateId || !customerId) {
      // Late/lean payloads: fetch the current billing request.
      const br = await gc.getBillingRequest(brId);
      mandateId = mandateId || br?.links?.mandate_request_mandate || null;
      customerId = customerId || br?.links?.customer || null;
    }
    if (mandateId) extraUpdate.gocardless_mandate_id = mandateId;
    if (customerId) extraUpdate.gocardless_customer_id = customerId;

    if (customerId) {
      await checkedUpsert(db, 'gocardless_customers', {
        tenant_id: agreement.tenant_id,
        member_id: agreement.member_id || null,
        organization_id: agreement.organization_id || null,
        gocardless_customer_id: customerId,
        environment: gc.getGocardlessEnvironment ? gc.getGocardlessEnvironment() : 'sandbox',
        updated_at: new Date().toISOString(),
      }, 'gocardless_customer_id');
    }
    if (mandateId) {
      await checkedUpsert(db, 'gocardless_mandates', {
        tenant_id: agreement.tenant_id,
        gocardless_customer_id: customerId || null,
        gocardless_mandate_id: mandateId,
        status: 'pending_submission',
        environment: gc.getGocardlessEnvironment ? gc.getGocardlessEnvironment() : 'sandbox',
        updated_at: new Date().toISOString(),
      }, 'gocardless_mandate_id');
    }

    const result = await applyStatusTransition({
      entityType: 'billing_agreement',
      entityId: agreement.id,
      toStatus: STATUS.MANDATE_PENDING,
      reason: 'billing request fulfilled',
      source: 'webhook',
      eventId: event.id,
      extraUpdate,
    }, { db });

    // Phase 3: a billing-contact invitation link becomes single-use once the
    // mandate flow completes. Best-effort — never fails the event.
    if (agreement.organization_id) {
      try {
        await markInvitationCompletedForAgreement(agreement.id, { db });
      } catch (err) {
        console.error('[GC Webhook] mark DD invitation completed failed:', err.message);
      }
    }
    return { handled: true, detail: `billing request fulfilled: ${JSON.stringify(result)}` };
  }

  if (action === 'cancelled' || action === 'failed') {
    const result = await applyStatusTransition({
      entityType: 'billing_agreement',
      entityId: agreement.id,
      toStatus: STATUS.PAYMENT_SETUP_REQUIRED,
      reason: `billing request ${action}`,
      source: 'webhook',
      eventId: event.id,
    }, { db });
    if (result.applied && agreement.metadata?.dd?.kind === 'monthly_direct_debit') {
      await safeDdEmail('setup_incomplete', agreement, { db });
    }
    return { handled: true, detail: `billing request ${action}: ${JSON.stringify(result)}` };
  }

  return { handled: false, detail: `ignored billing_requests action=${action}` };
}

// ---------------------------------------------------------------------------

const MANDATE_TERMINAL_ACTIONS = new Set(['cancelled', 'failed', 'expired']);

async function processMandateEvent({ event, action, links, db, gc }) {
  const mandateId = links.mandate;
  if (!mandateId) return { handled: false, detail: 'no mandate link' };

  // Mirror the mandate status locally (upsert tolerates unknown mandates
  // arriving before the billing-request fulfilled event).
  const { data: mandateRow, error: mErr } = await db
    .from('gocardless_mandates')
    .select('*')
    .eq('gocardless_mandate_id', mandateId)
    .maybeSingle();
  if (mErr) throw new Error(`load mandate failed: ${mErr.message}`);

  const details = [];
  const mappedStatus = {
    created: 'created',
    submitted: 'submitted',
    active: 'active',
    reinstated: 'active',
    cancelled: 'cancelled',
    failed: 'failed',
    expired: 'expired',
  }[action] || null;

  if (mandateRow && mappedStatus) {
    const { error } = await db
      .from('gocardless_mandates')
      .update({ status: mappedStatus, updated_at: new Date().toISOString() })
      .eq('id', mandateRow.id);
    if (error) throw new Error(`update mandate failed: ${error.message}`);
    details.push(`mandate mirror -> ${mappedStatus}`);
  }

  const agreement = await findAgreementByMandate(db, mandateId);

  if (action === 'active' || action === 'reinstated') {
    if (agreement) {
      const result = await applyStatusTransition({
        entityType: 'billing_agreement',
        entityId: agreement.id,
        toStatus: STATUS.FIRST_PAYMENT_PENDING,
        reason: `mandate ${action}`,
        source: 'webhook',
        eventId: event.id,
      }, { db });
      details.push(`agreement: ${JSON.stringify(result)}`);

      // Phase 2: a monthly-DD agreement now has an active mandate — create
      // the subscription from the stored snapshot and apply the tier's
      // activation rule. Both are idempotent, so re-delivered events are safe.
      if (agreement.metadata?.dd?.kind === 'monthly_direct_debit') {
        const subResult = await ensureSubscriptionForAgreement(agreement, { db, gc });
        details.push(`dd subscription: ${subResult.detail}`);
        const actResult = await activateMembershipForAgreement(agreement, { trigger: 'mandate_active', db });
        details.push(`dd activation: ${actResult.detail}`);
        const firstChargeDate = subResult.plan?.next_charge_date || subResult.plan?.start_date || null;
        if (result.applied) {
          await safeDdEmail('mandate_active', agreement, { db, extraContext: { firstChargeDate } });
        }
        if (subResult.created) {
          await safeDdEmail('first_collection_scheduled', agreement, { db, extraContext: { firstChargeDate } });
        }
        if (actResult.activated) {
          await safeDdEmail('membership_activated', agreement, { db });
        }
      }
    }
    return { handled: true, detail: details.join('; ') || 'mandate active (no local rows)' };
  }

  if (MANDATE_TERMINAL_ACTIONS.has(action)) {
    // Destructive path — confirm with the API before cancelling local
    // plans, so a late replayed event can't kill a healthy mandate.
    let confirmed = true;
    try {
      const current = await gc.getMandate(mandateId);
      confirmed = ['cancelled', 'failed', 'expired'].includes(current?.status);
      if (!confirmed) details.push(`API says mandate status=${current?.status}; skipping destructive change`);
    } catch (err) {
      // If the API can't confirm, do NOT cancel — flag for reconciliation.
      details.push(`API confirm failed (${err.message}); deferring to reconciliation`);
      confirmed = false;
    }

    if (confirmed) {
      if (agreement) {
        const result = await applyStatusTransition({
          entityType: 'billing_agreement',
          entityId: agreement.id,
          toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
          reason: `mandate ${action}`,
          source: 'webhook',
          eventId: event.id,
        }, { db });
        details.push(`agreement: ${JSON.stringify(result)}`);
        if (result.applied && agreement.metadata?.dd?.kind === 'monthly_direct_debit') {
          await safeDdEmail('plan_cancelled', agreement, { db });
        }
      }
      const plans = await findPlansByMandate(db, mandateId);
      for (const plan of plans) {
        const result = await applyStatusTransition({
          entityType: 'payment_plan',
          entityId: plan.id,
          toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
          reason: `mandate ${action}`,
          source: 'webhook',
          eventId: event.id,
        }, { db });
        details.push(`plan#${plan.id}: ${JSON.stringify(result)}`);
      }
    }
    return { handled: true, detail: details.join('; ') };
  }

  return { handled: true, detail: details.join('; ') || `mandate ${action} mirrored` };
}

// ---------------------------------------------------------------------------

async function processSubscriptionEvent({ event, action, links, db, gc }) {
  const subscriptionId = links.subscription;
  if (!subscriptionId) return { handled: false, detail: 'no subscription link' };
  const plan = await findPlanBySubscription(db, subscriptionId);
  if (!plan) return { handled: false, detail: `no local plan for subscription ${subscriptionId}` };

  if (action === 'created' || action === 'customer_approval_granted' || action === 'resumed') {
    const result = await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus: STATUS.FIRST_PAYMENT_PENDING,
      reason: `subscription ${action}`,
      source: 'webhook',
      eventId: event.id,
    }, { db });
    return { handled: true, detail: `subscription ${action}: ${JSON.stringify(result)}` };
  }

  if (action === 'cancelled') {
    // Confirm from the API before the destructive change.
    let confirmed = true;
    try {
      const current = await gc.getSubscription(subscriptionId);
      confirmed = current?.status === 'cancelled';
    } catch {
      confirmed = false;
    }
    if (!confirmed) return { handled: true, detail: 'API does not confirm cancellation; deferring' };
    const result = await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus: STATUS.PAYMENT_PLAN_CANCELLED,
      reason: 'subscription cancelled',
      source: 'webhook',
      eventId: event.id,
    }, { db });
    if (result.applied && plan.billing_agreement_id) {
      const agreement = await findAgreementById(db, plan.billing_agreement_id);
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        await safeDdEmail('plan_cancelled', agreement, { db });
      }
    }
    return { handled: true, detail: `subscription cancelled: ${JSON.stringify(result)}` };
  }

  if (action === 'finished') {
    const result = await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus: STATUS.EXPIRED,
      reason: 'subscription finished',
      source: 'webhook',
      eventId: event.id,
    }, { db });
    if (result.applied && plan.billing_agreement_id) {
      const agreement = await findAgreementById(db, plan.billing_agreement_id);
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        // All instalments collected — the membership year is fully settled.
        // Member agreements settle member_membership_history; organisational
        // agreements settle organisation_membership_history.
        const historyTable = membershipHistoryTableForAgreement(agreement);
        if (historyTable) {
          const { error: payErr } = await db
            .from(historyTable)
            .update({ payment_status: 'paid', paid_at: new Date().toISOString() })
            .eq('billing_agreement_id', agreement.id)
            .neq('payment_status', 'paid');
          if (payErr) console.error('[GC Webhook] mark DD membership paid failed:', payErr.message);
        }
        await safeDdEmail('plan_completed', agreement, { db });
      }
    }
    return { handled: true, detail: `subscription finished: ${JSON.stringify(result)}` };
  }

  if (action === 'payment_created') {
    // The payment resource event carries the detail; nothing to do here
    // beyond acknowledging.
    return { handled: true, detail: 'payment_created acknowledged (payment events drive state)' };
  }

  return { handled: false, detail: `ignored subscriptions action=${action}` };
}

// ---------------------------------------------------------------------------

async function processPaymentEvent({ event, action, links, db, gc }) {
  const paymentId = links.payment;
  if (!paymentId) return { handled: false, detail: 'no payment link' };

  const subscriptionId = links.subscription || null;
  const plan = subscriptionId ? await findPlanBySubscription(db, subscriptionId) : null;

  const mappedStatus = {
    created: 'pending_submission',
    submitted: 'submitted',
    confirmed: 'confirmed',
    paid_out: 'paid_out',
    failed: 'failed',
    cancelled: 'cancelled',
    charged_back: 'charged_back',
    late_failure_settled: 'failed',
    chargeback_settled: 'charged_back',
    resubmission_requested: 'submitted',
  }[action] || null;

  // Mirror the payment row (upsert on gocardless_payment_id). Tenant comes
  // from the plan when known; otherwise fetch the payment + its metadata.
  let tenantId = plan?.tenant_id || null;
  if (!tenantId) {
    const agreementMandate = links.mandate ? await findAgreementByMandate(db, links.mandate) : null;
    tenantId = agreementMandate?.tenant_id || null;
  }
  if (tenantId && mappedStatus) {
    await checkedUpsert(db, 'gocardless_payments', {
      tenant_id: tenantId,
      plan_id: plan?.id || null,
      gocardless_payment_id: paymentId,
      gocardless_subscription_id: subscriptionId,
      gocardless_mandate_id: links.mandate || null,
      status: mappedStatus,
      updated_at: new Date().toISOString(),
    }, 'gocardless_payment_id');
  }

  if (!plan) {
    return { handled: !!tenantId, detail: tenantId ? `payment ${action} mirrored (no local plan)` : `no local plan/tenant for payment ${paymentId}` };
  }

  const planUpdate = {
    last_payment_id: paymentId,
    last_payment_status: mappedStatus || action,
    last_payment_at: new Date().toISOString(),
  };

  if (action === 'confirmed' || action === 'paid_out') {
    const result = await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus: STATUS.ACTIVE,
      reason: `payment ${action}`,
      source: 'webhook',
      eventId: event.id,
      extraUpdate: { ...planUpdate, retry_count: 0 },
    }, { db });
    // Reflect on the agreement too (first successful collection activates it).
    if (plan.billing_agreement_id) {
      await applyStatusTransition({
        entityType: 'billing_agreement',
        entityId: plan.billing_agreement_id,
        toStatus: STATUS.ACTIVE,
        reason: `payment ${action}`,
        source: 'webhook',
        eventId: event.id,
      }, { db });

      // Phase 2: first confirmed collection — apply the tier's activation
      // rule, mark the membership row's payment progress, and send the
      // first-payment email exactly once (on the actual state transition).
      const agreement = await findAgreementById(db, plan.billing_agreement_id);
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        const actResult = await activateMembershipForAgreement(agreement, { trigger: 'first_payment_confirmed', db });
        await recordDdPaymentProgress(agreement, { db });
        if (actResult.activated) {
          await safeDdEmail('membership_activated', agreement, { db });
        }
        if (result.applied && result.fromStatus === STATUS.FIRST_PAYMENT_PENDING) {
          await safeDdEmail('first_payment', agreement, { db });
        } else if (action === 'confirmed') {
          // Subsequent instalment confirmed — 'confirmed' only, so the later
          // paid_out event for the same payment doesn't send a duplicate
          // (event-level idempotency also guards webhook redelivery).
          await safeDdEmail('payment_confirmed', agreement, { db });
        }
        return { handled: true, detail: `payment ${action}: ${JSON.stringify(result)}; dd activation: ${actResult.detail}` };
      }
    }
    return { handled: true, detail: `payment ${action}: ${JSON.stringify(result)}` };
  }

  if (action === 'failed' || action === 'late_failure_settled') {
    const retryCount = (plan.retry_count || 0) + 1;
    const toStatus = retryCount >= 2 ? STATUS.PAYMENT_OVERDUE : STATUS.PAYMENT_GRACE_PERIOD;
    const result = await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus,
      reason: `payment ${action} (failure #${retryCount})`,
      source: 'webhook',
      eventId: event.id,
      extraUpdate: { ...planUpdate, retry_count: retryCount },
    }, { db });
    if (result.applied && plan.billing_agreement_id) {
      const agreement = await findAgreementById(db, plan.billing_agreement_id);
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        await safeDdEmail(toStatus === STATUS.PAYMENT_OVERDUE ? 'payment_overdue' : 'payment_failed', agreement, { db });
      }
    }
    return { handled: true, detail: `payment ${action}: ${JSON.stringify(result)}` };
  }

  if (action === 'charged_back' || action === 'chargeback_settled') {
    // Destructive-ish: verify with the API before flagging overdue.
    let confirmed = true;
    try {
      const current = await gc.getPayment(paymentId);
      confirmed = ['charged_back', 'chargeback_settled'].includes(current?.status) || current?.status === 'failed';
    } catch {
      confirmed = false;
    }
    if (!confirmed) return { handled: true, detail: 'API does not confirm chargeback; deferring' };
    const result = await applyStatusTransition({
      entityType: 'payment_plan',
      entityId: plan.id,
      toStatus: STATUS.PAYMENT_OVERDUE,
      reason: `payment ${action}`,
      source: 'webhook',
      eventId: event.id,
      extraUpdate: planUpdate,
    }, { db });
    return { handled: true, detail: `payment ${action}: ${JSON.stringify(result)}` };
  }

  if (mappedStatus) {
    // Non-state-changing mirror only (created/submitted/cancelled/resubmission).
    const { error } = await db
      .from('membership_payment_plans')
      .update({ ...planUpdate, updated_at: new Date().toISOString() })
      .eq('id', plan.id);
    if (error) throw new Error(`update plan last-payment failed: ${error.message}`);
    return { handled: true, detail: `payment ${action} mirrored` };
  }

  return { handled: false, detail: `ignored payments action=${action}` };
}
