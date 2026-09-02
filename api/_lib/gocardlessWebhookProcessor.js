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
  restoreArrearsRoleAssignments,
} from './gocardlessArrears.js';
import {
  scheduleAutomaticRetry,
  clearAutomaticRetryForPlan,
  closeAutomaticRetrySchedule,
  completeCancellationClaim,
} from './gocardlessAutoRetry.js';
import { postDdInstalmentToAccounting, postDdArrearsPeriodToAccounting } from './gocardlessAccounting.js';
import { settleMonthlyArrears, postSettledArrearsPeriods, completeMonthlyCollectionIntent, failMonthlyCollectionIntent } from './monthlyArrearsCollection.js';

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

export function validateConfirmedCatchUpAmount(actualAmount, expectedAmount) {
  if (!Number.isInteger(actualAmount) || actualAmount <= 0) {
    throw new Error('confirmed catch-up payment has no valid authoritative amount');
  }
  if (!Number.isInteger(expectedAmount) || expectedAmount <= 0 || actualAmount !== expectedAmount) {
    throw new Error(`confirmed catch-up amount mismatch: expected ${expectedAmount}, got ${actualAmount}`);
  }
  return actualAmount;
}

export function isCatchUpTerminalFailureAction(action) {
  return ['failed', 'cancelled', 'charged_back', 'late_failure_settled', 'chargeback_settled'].includes(action);
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
      const { getTrustedBaseUrlForTenant } = await import('./publicBaseUrl.js');
      // Task #3502: finalisation runs the form's entity pipelines via an
      // internal HTTP call — without a baseUrl it silently skips them and
      // the member/org record is never created. Webhooks have no usable
      // request origin, so derive the tenant's trusted base URL.
      const baseUrl = await getTrustedBaseUrlForTenant(null, db, row.tenant_id);
      const { row: paidRow } = row.payment_status === 'pending'
        ? await markFormSubmissionPaid(db, row.id, { reference: brId })
        : { row };
      const { data: form } = await db
        .from('form')
        .select('id, name, tenant_id, fields, pages, visibility_rules, entity_pipelines, structured_actions, field_mappings, application_level, create_entity_type, entity_action, member_entity_action, organization_entity_action, additional_member_creations, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type')
        .eq('id', row.form_id)
        .eq('tenant_id', row.tenant_id)
        .maybeSingle();
      if (form) {
        await finalizeFormSubmission({
          supabase: db,
          submission: paidRow || { ...row, payment_status: 'paid' },
          form,
          baseUrl,
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
        await closeAutomaticRetrySchedule(plan, `mandate_${action}`, { db });
        await completeCancellationClaim(plan, plan.auto_retry_claim_token, {
          db,
          outcome: `mandate_${action}`,
        });
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
    await closeAutomaticRetrySchedule(plan, 'subscription_cancelled', { db });
    await completeCancellationClaim(plan, plan.auto_retry_claim_token, {
      db,
      outcome: 'subscription_cancelled',
    });
    if (result.applied && plan.billing_agreement_id) {
      const agreement = await findAgreementById(db, plan.billing_agreement_id);
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        await safeDdEmail('plan_cancelled', agreement, { db });
      }
    }
    return { handled: true, detail: `subscription cancelled: ${JSON.stringify(result)}` };
  }

  if (action === 'finished') {
    // A fixed subscription finishing is not membership-plan completion while
    // monthly arrears remain. Keep it recoverable for manual/catch-up action.
    try {
      const { count, error: arrearsError } = await db
        .from('membership_monthly_arrears_period')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', plan.tenant_id)
        .eq('plan_id', plan.id)
        .is('settled_at', null);
      if (!arrearsError && (count || 0) > 0) {
        const { error: flagError } = await db.from('membership_payment_plans').update({
          needs_attention: true,
          attention_reason: 'Fixed subscription finished with unresolved monthly arrears.',
          updated_at: new Date().toISOString(),
        }).eq('id', plan.id).eq('tenant_id', plan.tenant_id);
        if (flagError) throw new Error(`flag unresolved completion arrears failed: ${flagError.message}`);
        return { handled: true, detail: 'subscription finished but unresolved arrears prevent completion' };
      }
    } catch (err) {
      // Pre-ledger environments retain historical completion behaviour.
      if (err?.code !== '42P01') throw err;
    }
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
    await closeAutomaticRetrySchedule(plan, 'subscription_finished', { db });
    await completeCancellationClaim(plan, plan.auto_retry_claim_token, {
      db,
      outcome: 'subscription_finished',
    });
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
  let plan = subscriptionId ? await findPlanBySubscription(db, subscriptionId) : null;
  const { data: immutableIntentMatch, error: immutableIntentError } = await db
    .from('membership_monthly_collection_intent').select('*')
    .eq('provider_reference', paymentId).maybeSingle();
  if (immutableIntentError && !['42P01', '42703'].includes(immutableIntentError.code)) {
    throw new Error(`load immutable payment intent failed: ${immutableIntentError.message}`);
  }
  let matchedCollectionIntent = immutableIntentMatch || null;
  if (plan && matchedCollectionIntent
    && (plan.id !== matchedCollectionIntent.plan_id || plan.tenant_id !== matchedCollectionIntent.tenant_id)) {
    throw new Error('catch-up intent does not belong to resolved payment plan');
  }
  // Catch-up one-off payments intentionally have no subscription link. Resolve
  // only through a tenant-owned mirror or the persisted provider intent.
  if (!plan) {
    const { data: mirrored } = await db.from('gocardless_payments')
      .select('plan_id, membership_payment_plans(*)')
      .eq('gocardless_payment_id', paymentId).maybeSingle();
    plan = mirrored?.membership_payment_plans || null;
    if (!plan) {
      const immutableIntent = matchedCollectionIntent;
      if (immutableIntent?.tenant_id && immutableIntent?.plan_id) {
        const { data: intentPlan } = await db.from('membership_payment_plans').select('*')
          .eq('id', immutableIntent.plan_id).eq('tenant_id', immutableIntent.tenant_id).maybeSingle();
        plan = intentPlan || null;
      }
    }
  }

  if (!plan && action === 'confirmed') {
    const authoritative = await gc.getPayment(paymentId);
    const meta = authoritative?.metadata || {};
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!meta.catch_up_intent_key || !uuid.test(meta.tenant_id || '') || !uuid.test(meta.plan_id || '')) {
      throw new Error('GoCardless catch-up recovery metadata is missing or invalid');
    }
    const { data: metadataPlan, error: metadataPlanError } = await db.from('membership_payment_plans')
      .select('*').eq('id', meta.plan_id).eq('tenant_id', meta.tenant_id).maybeSingle();
    if (metadataPlanError || !metadataPlan) throw new Error(metadataPlanError?.message || 'GoCardless recovery plan not found');
    if (metadataPlan.provider === 'stripe' || metadataPlan.interval_unit !== 'monthly') {
      throw new Error('GoCardless recovery plan provider/interval mismatch');
    }
    const { data: creatingIntent, error: creatingError } = await db.from('membership_monthly_collection_intent')
      .select('*').eq('tenant_id', meta.tenant_id).eq('plan_id', meta.plan_id)
      .eq('intent_key', meta.catch_up_intent_key).eq('status', 'creating').maybeSingle();
    if (creatingError || !creatingIntent) throw new Error(creatingError?.message || 'recoverable GoCardless intent not found');
    const fingerprint = (creatingIntent.period_ids || []).join(',');
    if (Number(authoritative.amount) !== Number(creatingIntent.arrears_amount_minor)
      || String(authoritative.currency || '').toUpperCase() !== String(metadataPlan.currency || '').toUpperCase()
      || meta.arrears_period_ids !== fingerprint
      || Number(meta.arrears_amount_minor) !== Number(creatingIntent.arrears_amount_minor)) {
      throw new Error('GoCardless catch-up recovery amount/currency/period fingerprint mismatch');
    }
    const { data: recovered, error: recoverError } = await db.rpc('recover_membership_monthly_collection_provider_ref', {
      p_tenant_id: meta.tenant_id, p_plan_id: meta.plan_id, p_intent_key: meta.catch_up_intent_key,
      p_provider_reference: paymentId, p_provider_charge_date: authoritative.charge_date || null,
    });
    if (recoverError) throw new Error(`recover GC catch-up provider reference failed: ${recoverError.message}`);
    plan = metadataPlan;
    matchedCollectionIntent = Array.isArray(recovered) ? recovered[0] : recovered;
  }

  // Split-window repair: provider mutation succeeded but atomic local
  // reference recording did not. Trust metadata only after retrieving the
  // authoritative GoCardless payment and bind it to the tenant-owned plan.
  if (action === 'confirmed' && plan && !matchedCollectionIntent) {
    const authoritative = await gc.getPayment(paymentId);
    const meta = authoritative?.metadata || {};
    if (meta.catch_up_intent_key) {
      if (meta.tenant_id !== plan.tenant_id || meta.plan_id !== plan.id) {
        throw new Error('GoCardless catch-up metadata tenant/plan mismatch');
      }
      const { data: creatingIntent, error: creatingError } = await db
        .from('membership_monthly_collection_intent').select('*')
        .eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id)
        .eq('intent_key', meta.catch_up_intent_key).eq('status', 'creating').maybeSingle();
      if (creatingError) throw new Error(`load recoverable GC catch-up intent failed: ${creatingError.message}`);
      if (creatingIntent) {
        if (authoritative.amount !== creatingIntent.arrears_amount_minor
          || (authoritative.currency && creatingIntent.currency && authoritative.currency !== creatingIntent.currency)) {
          throw new Error('GoCardless catch-up recovery amount/currency mismatch');
        }
        const { data: recovered, error: recoverError } = await db.rpc('recover_membership_monthly_collection_provider_ref', {
          p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_intent_key: creatingIntent.intent_key,
          p_provider_reference: paymentId, p_provider_charge_date: authoritative.charge_date || null,
        });
        if (recoverError) throw new Error(`recover GC catch-up provider reference failed: ${recoverError.message}`);
        matchedCollectionIntent = Array.isArray(recovered) ? recovered[0] : recovered;
      }
    }
  }

  // Catch-up confirmation preflight MUST precede every local mutation. The
  // immutable intent, not the mutable plan pointer, classifies this payment.
  const preflightCatchUpIntent = action === 'confirmed' ? matchedCollectionIntent : null;
  const isPreflightCatchUp = !!preflightCatchUpIntent
    && paymentId === preflightCatchUpIntent.provider_reference;
  if (isPreflightCatchUp && preflightCatchUpIntent.status === 'completed') {
    return { handled: true, detail: 'duplicate completed GoCardless catch-up confirmation' };
  }
  let preflightPayment = null;
  let authoritativeCatchUpAmountMinor = null;
  if (isPreflightCatchUp) {
    preflightPayment = await gc.getPayment(paymentId);
    authoritativeCatchUpAmountMinor = validateConfirmedCatchUpAmount(
      preflightPayment?.amount,
      Number(preflightCatchUpIntent.arrears_amount_minor),
    );
  }
  const isMatchedCatchUpFailure = !!matchedCollectionIntent && !!plan && isCatchUpTerminalFailureAction(action);
  if (isMatchedCatchUpFailure) {
    await failMonthlyCollectionIntent({
      plan, intent: matchedCollectionIntent, providerReference: paymentId,
      providerOutcome: action, errorMessage: `GoCardless catch-up payment ${action}`, db,
    });
  }
  if (!matchedCollectionIntent && plan && isCatchUpTerminalFailureAction(action)) {
    const failedPayment = await gc.getPayment(paymentId);
    const failedDuePeriod = /^\d{4}-\d{2}-\d{2}$/.test(failedPayment?.charge_date || '')
      ? failedPayment.charge_date : null;
    if (!failedDuePeriod) throw new Error('GoCardless recurring failure has no authoritative charge_date');
    const { error: failedPeriodError } = await db.from('membership_payment_plans').update({
      failed_due_period: failedDuePeriod, failed_provider_reference: paymentId,
      updated_at: new Date().toISOString(),
    }).eq('id', plan.id).eq('tenant_id', plan.tenant_id);
    if (failedPeriodError) throw new Error(`persist GoCardless failed due period failed: ${failedPeriodError.message}`);
    plan.failed_due_period = failedDuePeriod;
    plan.failed_provider_reference = paymentId;
  }

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
  if (isMatchedCatchUpFailure) {
    return { handled: true, detail: `GoCardless catch-up payment ${action} recorded for retry` };
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
    const recoveredFromArrears = plan.status === STATUS.PAYMENT_GRACE_PERIOD
      || plan.status === STATUS.PAYMENT_OVERDUE
      || !!plan.arrears_policy_applied;
    const recoveryAgreement = recoveredFromArrears && plan.billing_agreement_id
      ? await findAgreementById(db, plan.billing_agreement_id)
      : null;
    if (recoveredFromArrears) {
      await restoreArrearsRoleAssignments({ plan, agreement: recoveryAgreement, db });
    }
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
    // A confirmed collection closes any automatic retry schedule and marks
    // the plan recovered. This is deliberately separate from retry_count:
    // that column is the arrears failure count, not the automatic allowance.
    await clearAutomaticRetryForPlan(plan, { db, outcome: 'recovered' });

    const catchUpIntent = preflightCatchUpIntent;
    const isCatchUpPayment = isPreflightCatchUp;
    const expectedCatchUpAmountMinor = isCatchUpPayment ? Number(catchUpIntent.arrears_amount_minor) : null;

    // Finance mirror enrichment: fetch amount/description from the API
    // (best-effort — mirror already has status).
    let paymentRowForAccounting = null;
    try {
      const current = preflightPayment || await gc.getPayment(paymentId);
      if (isCatchUpPayment) {
        authoritativeCatchUpAmountMinor = validateConfirmedCatchUpAmount(current?.amount, expectedCatchUpAmountMinor);
      }
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
      // Ordinary subscription enrichment remains best-effort. A matched
      // catch-up is financial completion work, so acknowledgement is unsafe:
      // force webhook/reconcile replay instead.
      if (isCatchUpPayment) throw new Error(`catch-up payment enrichment failed: ${err.message}`);
    }
    // The DB function is idempotent by open period state and locks the plan;
    // a confirmed catch-up payment settles debt oldest-first. It deliberately
    // does not alter access policy or the provider's in-grace retry timing.
    if (isCatchUpPayment) {
      const expectedAmountMinor = expectedCatchUpAmountMinor;
      if (!Number.isInteger(expectedAmountMinor) || expectedAmountMinor <= 0) {
        throw new Error('matched catch-up intent has no valid arrears amount');
      }
      // Confirm the authoritative provider amount is durably present. It was
      // validated above; immutable expected data is never written over a
      // differing provider amount.
      const { data: repairedRows, error: repairError } = await db.from('gocardless_payments').update({
        amount_minor: authoritativeCatchUpAmountMinor,
        updated_at: new Date().toISOString(),
      }).eq('gocardless_payment_id', paymentId).eq('tenant_id', plan.tenant_id).select('*');
      if (repairError) throw new Error(`persist catch-up payment amount failed: ${repairError.message}`);
      paymentRowForAccounting = repairedRows?.[0] || paymentRowForAccounting;
      if (!paymentRowForAccounting) throw new Error('persisted catch-up payment mirror not found');
      const catchUpAgreement = recoveryAgreement || await findAgreementById(db, plan.billing_agreement_id);
      await settleMonthlyArrears({
        tenantId: plan.tenant_id,
        planId: plan.id,
        amountMinor: expectedAmountMinor,
        settlementReference: paymentId,
        periodIds: catchUpIntent.period_ids || null,
        db,
      });
      await postSettledArrearsPeriods({
        tenantId: plan.tenant_id, planId: plan.id, providerReference: paymentId,
        agreement: catchUpAgreement, db,
        postPeriod: ({ amountMinor, externalReference }) =>
          (deps.postArrearsPeriod || postDdArrearsPeriodToAccounting)(
            { agreement: catchUpAgreement, amountMinor, externalReference },
            { db },
          ),
      });
      await completeMonthlyCollectionIntent({ plan, intent: catchUpIntent, providerReference: paymentId, db });
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
      const agreement = recoveryAgreement || await findAgreementById(db, plan.billing_agreement_id);
      if (agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
        const actResult = await activateMembershipForAgreement(agreement, { trigger: 'first_payment_confirmed', db });
        await recordDdPaymentProgress(agreement, { db });
        // Recovery: clear any arrears flag stamped on the agreement.
        if (agreement.metadata?.dd?.arrears_state) {
          await clearAgreementArrearsFlag(agreement, { db });
        }
        if (recoveredFromArrears && action === 'confirmed') {
          await safeDdEmail('payment_recovered', agreement, { db });
        }
        // Post the confirmed instalment to accounting (best-effort; records
        // its own posted/failed/skipped status on the payment row).
        if (action === 'confirmed' && paymentRowForAccounting && !isCatchUpPayment) {
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
    const autoRetry = await scheduleAutomaticRetry({
      tenantId,
      plan: { ...plan, status: toStatus, grace_expires_at: graceExpiresAt, last_payment_id: paymentId },
      paymentId,
      failedAt: new Date(),
      db,
    });
    if (result.applied && agreement?.metadata?.dd?.kind === 'monthly_direct_debit') {
      await safeDdEmail(toStatus === STATUS.PAYMENT_OVERDUE ? 'payment_overdue' : 'payment_failed', agreement, { db });
    }
    return { handled: true, detail: `payment ${action}: ${JSON.stringify(result)} (grace expires ${graceExpiresAt}; auto retry ${autoRetry.reason || autoRetry.dueAt || 'scheduled'})` };
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
