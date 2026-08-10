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
import {
  handlePaymentFailure,
  recoveryPlanUpdate,
  clearAgreementArrearsFlag,
} from './gocardlessArrears.js';
import { postDdInstalmentToAccounting } from './gocardlessAccounting.js';

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
      return processPaymentEvent({ event, action, links, db, gc, deps });
    case 'refunds':
      return processRefundEvent({ event, action, links, db, gc });
    case 'payouts':
      return processPayoutEvent({ event, action, links, db, gc });
    default:
      return { handled: false, detail: `ignored resource_type=${resourceType}` };
  }
}

// ---------------------------------------------------------------------------

async function processBillingRequestEvent({ event, action, links, db, gc }) {
  const brId = links.billing_request;
  if (!brId) return { handled: false, detail: 'no billing_request link' };

  // Task #3483: generic form Payment field billing requests are tracked on
  // form_submission (payment_reference = billing request id), not on a
  // billing agreement. Handle them first so the agreement lookup below
  // doesn't dismiss the event.
  const formPaymentResult = await maybeProcessFormPaymentBillingRequest({ action, brId, db, gc });
  if (formPaymentResult) return formPaymentResult;

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

// Task #3483: billing requests created by the generic form Payment field.
// Returns null when the billing request is not a form payment (fall through
// to the agreement path). Marks the pending form_submission paid via the
// shared CAS and runs finalisation exactly once.
async function maybeProcessFormPaymentBillingRequest({ action, brId, db, gc }) {
  let row = null;
  try {
    const { data, error } = await db
      .from('form_submission')
      .select('*')
      .eq('payment_provider', 'gocardless')
      .eq('payment_reference', brId)
      .maybeSingle();
    if (error) throw error;
    row = data;
  } catch (err) {
    // Pre-migration DB (42703) — not a form payment environment.
    return null;
  }
  if (!row) return null;

  if (action === 'fulfilled') {
    if (row.payment_status === 'paid') {
      // Ensure finalisation ran even if a previous winner crashed mid-way.
    } else if (row.payment_status !== 'pending') {
      return { handled: true, detail: `form payment ${row.id} in state ${row.payment_status}; ignored` };
    }
    try {
      const { markFormSubmissionPaid, finalizeFormSubmission } = await import('./formPaymentFinalize.js');
      const { row: paidRow } = row.payment_status === 'pending'
        ? await markFormSubmissionPaid(db, row.id, { reference: brId })
        : { row };
      const { data: form } = await db
        .from('form')
        .select('id, name, tenant_id, fields, pages, visibility_rules, entity_pipelines, field_mappings, application_level, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type')
        .eq('id', row.form_id)
        .eq('tenant_id', row.tenant_id)
        .maybeSingle();
      if (form) {
        await finalizeFormSubmission({
          supabase: db,
          submission: paidRow || { ...row, payment_status: 'paid' },
          form,
          baseUrl: null,
        });
      }
      return { handled: true, detail: `form payment ${row.id} marked paid (billing request fulfilled)` };
    } catch (err) {
      console.error('[GC Webhook] form payment fulfil failed:', err.message);
      return { handled: false, detail: `form payment ${row.id} fulfil failed: ${err.message}` };
    }
  }

  if (action === 'cancelled' || action === 'failed') {
    await db
      .from('form_submission')
      .update({ payment_status: 'failed' })
      .eq('id', row.id)
      .eq('payment_status', 'pending');
    return { handled: true, detail: `form payment ${row.id} billing request ${action}` };
  }

  return { handled: true, detail: `form payment ${row.id}: ignored billing_requests action=${action}` };
}

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
          // Mandate cancellation ≠ membership cancellation: tell the payer
          // the mandate is gone and a replacement can be set up.
          await safeDdEmail('mandate_cancelled', agreement, { db });
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
      // Phase 5: stamp completion so the renewal cron can detect finished
      // plans (mandate stays active; membership stays valid).
      extraUpdate: { completed_at: new Date().toISOString() },
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

async function processPaymentEvent({ event, action, links, db, gc, deps = {} }) {
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
    const mirror = {
      tenant_id: tenantId,
      plan_id: plan?.id || null,
      gocardless_payment_id: paymentId,
      gocardless_subscription_id: subscriptionId,
      gocardless_mandate_id: links.mandate || null,
      status: mappedStatus,
      updated_at: new Date().toISOString(),
    };
    if (action === 'confirmed') mirror.confirmed_at = new Date().toISOString();
    if (action === 'paid_out') {
      mirror.paid_out_at = new Date().toISOString();
      if (links.payout) mirror.gocardless_payout_id = links.payout;
    }
    if (action === 'charged_back' || action === 'chargeback_settled') {
      mirror.charged_back_at = new Date().toISOString();
    }
    await checkedUpsert(db, 'gocardless_payments', mirror, 'gocardless_payment_id');
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
      extraUpdate: { ...planUpdate, ...recoveryPlanUpdate() },
    }, { db });

    // Recovery bookkeeping even when the plan was already ACTIVE
    // (subsequent instalments): clear any stale arrears columns.
    if (!result.applied && (plan.retry_count || plan.grace_expires_at || plan.arrears_policy_applied)) {
      const { error: clrErr } = await db
        .from('membership_payment_plans')
        .update({ ...recoveryPlanUpdate(), updated_at: new Date().toISOString() })
        .eq('id', plan.id);
      if (clrErr) console.error('[GC Webhook] clear arrears bookkeeping failed:', clrErr.message);
    }

    // Finance mirror enrichment: fetch amount/description from the API
    // (best-effort — mirror already has status).
    let paymentRowForAccounting = null;
    try {
      const current = await gc.getPayment(paymentId);
      if (current?.amount != null) {
        const { data: updatedRows, error: amtErr } = await db
          .from('gocardless_payments')
          .update({
            amount_minor: current.amount,
            currency: current.currency || null,
            description: current.description || null,
            charge_date: current.charge_date || null,
            updated_at: new Date().toISOString(),
          })
          .eq('gocardless_payment_id', paymentId)
          .select('*');
        if (amtErr) console.error('[GC Webhook] enrich payment mirror failed:', amtErr.message);
        paymentRowForAccounting = updatedRows?.[0] || null;
      }
    } catch (err) {
      console.error('[GC Webhook] fetch payment for enrichment failed:', err.message);
    }
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
        // Recovery: clear any arrears flag stamped on the agreement.
        if (agreement.metadata?.dd?.arrears_state) {
          await clearAgreementArrearsFlag(agreement, { db });
        }
        // Post the confirmed instalment to accounting (best-effort; records
        // its own posted/failed/skipped status on the payment row).
        if (action === 'confirmed' && paymentRowForAccounting) {
          const postFn = deps.postToAccounting || postDdInstalmentToAccounting;
          try {
            await postFn({ agreement, paymentRow: paymentRowForAccounting }, { db });
          } catch (err) {
            console.error('[GC Webhook] accounting posting threw:', err.message);
          }
        }
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
    // Arrears state machine: grace window from the SNAPSHOT grace days on
    // the agreement (metadata.dd), never live tier config.
    const agreement = plan.billing_agreement_id ? await findAgreementById(db, plan.billing_agreement_id) : null;
    const planUpdateErr = await db
      .from('membership_payment_plans')
      .update({ ...planUpdate, updated_at: new Date().toISOString() })
      .eq('id', plan.id);
    if (planUpdateErr.error) console.error('[GC Webhook] failure last-payment update failed:', planUpdateErr.error.message);
    const { toStatus, result, graceExpiresAt } = await handlePaymentFailure({ plan, agreement, event, action, db });
    if (result.applied && agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
      await safeDdEmail(toStatus === STATUS.PAYMENT_OVERDUE ? 'payment_overdue' : 'payment_failed', agreement, { db });
    }
    return { handled: true, detail: `payment ${action}: ${JSON.stringify(result)} (grace expires ${graceExpiresAt})` };
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

    // Post-payout reversal: money already paid out is being clawed back —
    // flag the payment row so finance surfaces can reconcile.
    const { data: payRow } = await db
      .from('gocardless_payments')
      .select('id, paid_out_at')
      .eq('gocardless_payment_id', paymentId)
      .maybeSingle();
    if (payRow?.paid_out_at) {
      const { error: cbErr } = await db
        .from('gocardless_payments')
        .update({ chargeback_reversed_after_payout: true, updated_at: new Date().toISOString() })
        .eq('id', payRow.id);
      if (cbErr) console.error('[GC Webhook] chargeback reversal flag failed:', cbErr.message);
    }

    // A chargeback reopens arrears via the same snapshot-grace machinery.
    const agreement = plan.billing_agreement_id ? await findAgreementById(db, plan.billing_agreement_id) : null;
    const { result } = await handlePaymentFailure({ plan, agreement, event, action, db });
    if (result.applied && agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
      await safeDdEmail('payment_overdue', agreement, { db });
    }
    return { handled: true, detail: `payment ${action}: ${JSON.stringify(result)}${payRow?.paid_out_at ? ' (post-payout reversal)' : ''}` };
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

// ---------------------------------------------------------------------------
// Refunds (Phase 4) — mirror refund lifecycle onto gocardless_refunds and
// keep the payment row's refund rollup (amount_refunded_minor/refund_status)
// current. Webhook-mirrored refunds and admin-initiated ones share the same
// row via the gocardless_refund_id unique index.

async function processRefundEvent({ event, action, links, db, gc }) {
  const refundId = links.refund;
  if (!refundId) return { handled: false, detail: 'no refund link' };

  // Authoritative state from the API (webhook payloads are thin).
  let refund = null;
  try {
    refund = await gc.getRefund(refundId);
  } catch (err) {
    console.error('[GC Webhook] getRefund failed:', err.message);
  }
  const paymentId = refund?.links?.payment || links.payment || null;

  // Find the mirrored payment row for tenant attribution.
  let payRow = null;
  if (paymentId) {
    const { data } = await db
      .from('gocardless_payments')
      .select('id, tenant_id, amount_minor, paid_out_at')
      .eq('gocardless_payment_id', paymentId)
      .maybeSingle();
    payRow = data || null;
  }
  if (!payRow?.tenant_id) {
    return { handled: false, detail: `no mirrored payment for refund ${refundId}` };
  }

  const statusByAction = {
    created: 'created',
    funds_returned: 'funds_returned',
    paid: 'paid',
    refund_settled: 'refund_settled',
    failed: 'failed',
  };
  const status = statusByAction[action] || action;

  await checkedUpsert(db, 'gocardless_refunds', {
    tenant_id: payRow.tenant_id,
    gocardless_refund_id: refundId,
    gocardless_payment_id: paymentId,
    payment_row_id: payRow.id,
    amount_minor: refund?.amount ?? null,
    currency: refund?.currency || null,
    status,
    metadata: refund?.metadata || null,
    updated_at: new Date().toISOString(),
  }, 'gocardless_refund_id');

  // Roll up total refunded onto the payment. Recompute on EVERY lifecycle
  // change — including 'failed' — so a previously-counted refund that later
  // fails is removed from the rollup immediately (not on the next unrelated
  // event). Failed/cancelled refunds never left the account and must not
  // inflate the rollup or block later admin refunds.
  {
    let totalRefunded = null;
    try {
      const all = await gc.listRefunds({ paymentId });
      const counted = all.filter((r) => !['failed', 'cancelled'].includes(r.status));
      totalRefunded = counted.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    } catch (err) {
      console.error('[GC Webhook] listRefunds rollup failed:', err.message);
    }
    if (totalRefunded != null) {
      const gross = payRow.amount_minor || 0;
      const refundStatus = totalRefunded <= 0
        ? null
        : (gross > 0 && totalRefunded >= gross ? 'refunded' : 'partially_refunded');
      const { error } = await db
        .from('gocardless_payments')
        .update({
          amount_refunded_minor: totalRefunded,
          refund_status: refundStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('id', payRow.id);
      if (error) console.error('[GC Webhook] refund rollup update failed:', error.message);
    }
  }

  return { handled: true, detail: `refund ${action} mirrored (${refundId})` };
}

// ---------------------------------------------------------------------------
// Payouts (Phase 4 — finance/reconciliation). Mirrors the payout row and
// stamps gross/fee/net + payout linkage onto each included payment via
// payout_items.

async function processPayoutEvent({ event, action, links, db, gc }) {
  const payoutId = links.payout;
  if (!payoutId) return { handled: false, detail: 'no payout link' };

  let payout = null;
  try {
    payout = await gc.getPayout(payoutId);
  } catch (err) {
    console.error('[GC Webhook] getPayout failed:', err.message);
  }

  // Stamp finance data onto each included payment.
  let itemsDetail = 'no items fetched';
  let tenantId = null;
  try {
    const items = await gc.listPayoutItems({ payoutId });
    // gross/fee per payment: type 'payment_paid_out' carries gross, fee types are negative amounts.
    const perPayment = new Map();
    for (const item of items) {
      const pid = item?.links?.payment;
      if (!pid) continue;
      const entry = perPayment.get(pid) || { gross: 0, fees: 0 };
      // payout_items amounts are strings already in minor units (pence).
      const minor = Math.round(Number(item.amount)) || 0;
      if (item.type === 'payment_paid_out') entry.gross += minor;
      else entry.fees += minor; // fees are negative amounts
      perPayment.set(pid, entry);
    }
    let stamped = 0;
    for (const [pid, entry] of perPayment) {
      const feeMinor = Math.abs(entry.fees);
      const { data: updated, error } = await db
        .from('gocardless_payments')
        .update({
          gocardless_payout_id: payoutId,
          payout_reference: payout?.reference || null,
          payout_date: payout?.arrival_date || null,
          paid_out_at: new Date().toISOString(),
          fee_minor: feeMinor,
          net_minor: entry.gross - feeMinor,
          updated_at: new Date().toISOString(),
        })
        .eq('gocardless_payment_id', pid)
        .select('tenant_id');
      if (error) console.error('[GC Webhook] payout stamp failed:', error.message);
      else if (updated?.length) {
        stamped += 1;
        tenantId = tenantId || updated[0].tenant_id;
      }
    }
    itemsDetail = `${stamped}/${perPayment.size} payments stamped`;
  } catch (err) {
    console.error('[GC Webhook] listPayoutItems failed:', err.message);
    itemsDetail = `payout items fetch failed: ${err.message}`;
  }

  await checkedUpsert(db, 'gocardless_payouts', {
    tenant_id: tenantId,
    gocardless_payout_id: payoutId,
    reference: payout?.reference || null,
    amount_minor: payout?.amount ?? null,
    deducted_fees_minor: payout?.deducted_fees ?? null,
    currency: payout?.currency || null,
    status: payout?.status || action,
    arrival_date: payout?.arrival_date || null,
    metadata: payout?.metadata || null,
    updated_at: new Date().toISOString(),
  }, 'gocardless_payout_id');

  return { handled: true, detail: `payout ${action} mirrored (${itemsDetail})` };
}
