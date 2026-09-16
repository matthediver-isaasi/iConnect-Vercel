/**
 * Form payment reconciliation (Task #3483) — mirrors the job-posting
 * reconciler: sweeps form_submission rows stuck in payment_status='pending'
 * whose provider-side payment actually succeeded (browser closed before the
 * confirm call, network drop after Stripe charged, GC redirect never
 * landed), marks them paid via the shared CAS and runs finalisation exactly
 * once. Also re-runs finalisation for paid rows whose side effects never
 * completed (payment_meta.finalized missing).
 *
 * Idempotent and race-proof: the CAS in markFormSubmissionPaid means a
 * concurrent browser confirm and this sweep can never double-process.
 */
import { retrieveTenantPaymentIntent } from './stripeCredentials.js';
import { randomUUID } from 'node:crypto';
import { gocardlessForTenant } from './gocardless.js';
import {
  markFormSubmissionPaid,
  finalizeFormSubmission,
  queueFormPaymentCompletion,
  FORM_PAYMENT_COMPLETION_BUDGET_MS,
} from './formPaymentFinalize.js';
import { finalizeFormMembership, WORKFLOW_CLAIM_TTL_MS } from './formMembershipFinalize.js';
import { runFormEntityPipelines } from './formEntityPipelines.js';
import { getTrustedBaseUrlForTenant } from './publicBaseUrl.js';
import { finalizeFormMonthlyCardCheckout, FINALIZE_CLAIM_TTL_MS } from './formMonthlyCardFinalize.js';
import { findFormMonthlyCardAgreement } from './formMonthlyCardCheckout.js';
import { hasFormPaymentAccessProof } from './formPaymentAccess.js';
import { capturePaymentIntentBillingAddress } from './stripeInvoiceAddress.js';
import {
  patchFormSubmissionPaymentMeta,
  retryPersistedStripeAddressMappings,
  captureFormStripeBillingAddressOnce,
} from './formStripeAddressMappingProcessing.js';
import {
  findFormMonthlyDirectDebitAgreement,
  persistMonthlyDirectDebitLink,
} from './formMonthlyDirectDebitCheckout.js';
import {
  FINALIZE_CLAIM_TTL_MS as DD_FINALIZE_CLAIM_TTL_MS,
} from './formMonthlyDirectDebitFinalize.js';
import { processGocardlessEvent } from './gocardlessWebhookProcessor.js';
import {
  FORM_STRIPE_SETTLEMENT_CLAIM_TTL_MS,
  formMembershipQuoteAmountMinor,
} from './formStripeInvoiceSettlement.js';
import { reconcilePaidFormDueDiligence } from './formDueDiligence.js';

const FORM_COLUMNS = 'id, name, tenant_id, access_policy, fields, pages, visibility_rules, entity_pipelines, structured_actions, field_mappings, application_level, auto_create_entity, create_entity_type, entity_action, member_entity_action, organization_entity_action, additional_member_creations, default_member_role_id, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type, due_diligence_required, survey_settings';

// Only look at rows old enough that the browser confirm is clearly not
// coming, and young enough to be worth polling.
const MIN_AGE_MS = 10 * 60 * 1000;
const MAX_AGE_DAYS = 14;

/**
 * Keep monitoring-only partial failures off the public cron response while
 * still letting the cron handler report them to Better Stack. The reconciler
 * intentionally returns its normal summary after a recoverable sweep error,
 * so making this enumerable would needlessly change that response contract.
 */
function recordMonitoringFailure(results, scope, error) {
  if (!Object.prototype.hasOwnProperty.call(results, '__heartbeatFailures')) {
    Object.defineProperty(results, '__heartbeatFailures', {
      value: [],
      enumerable: false,
      configurable: true,
    });
  }
  results.__heartbeatFailures.push({
    scope,
    error: error?.message || String(error),
  });
}

// A paid one-off may have crashed after its financial finalized stamp but
// before the durable DD-ready marker. Claim this prerequisite-only recovery
// separately from DD actions so concurrent crons cannot rerun it together.
async function recoverMissingOneOffDueDiligenceReadiness(supabase, { resolveBaseUrl, limit, deadlineAt = null }) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const { data: attentionRows, error: attentionError } = await supabase
    .rpc('mark_expired_missing_one_off_form_due_diligence_ready_attention', { p_limit: boundedLimit });
  if (attentionError) throw attentionError;
  const { data: rows, error } = await supabase.rpc('claim_missing_one_off_form_due_diligence_ready', {
    p_limit: boundedLimit,
  });
  if (error) throw error;
  const outcomes = [];
  for (const row of rows || []) {
    if (deadlineAt && Date.now() >= deadlineAt) {
      outcomes.push({ submissionId: row.form_submission_id, succeeded: false, budgetExhausted: true });
      break;
    }
    let succeeded = false;
    let failure = null;
    try {
      const { data: submission, error: submissionError } = await supabase
        .from('form_submission').select('*').eq('id', row.form_submission_id)
        .eq('tenant_id', row.tenant_id).maybeSingle();
      if (submissionError || !submission) throw submissionError || new Error('Submission not found');
      if (Number(submission.payment_meta?.completion?.version) === 1
          && submission.payment_meta?.completion?.status !== 'done') {
        // v1 receipt-owned submissions resume only through the completion
        // queue. Release this prerequisite claim without initiating DD ahead
        // of an incomplete/ambiguous entity pipeline.
        const { error: releaseError } = await supabase.rpc('finish_missing_one_off_form_due_diligence_ready', {
          p_tenant_id: row.tenant_id,
          p_submission_id: row.form_submission_id,
          p_lease_token: row.lease_token,
          p_succeeded: false,
          p_error: 'managed by paid completion receipt',
        });
        if (releaseError) throw releaseError;
        outcomes.push({
          submissionId: row.form_submission_id,
          succeeded: false,
          managedByCompletion: true,
        });
        continue;
      }
      if (submission.payment_meta?.completion?.status === 'attention') {
        // Leave this recovery lease for its existing attention watchdog rather
        // than releasing it back to a retryable state.  Financial completion
        // has an unknown effect and DD readiness must not bypass that gate.
        outcomes.push({
          submissionId: row.form_submission_id,
          succeeded: false,
          requiresAttention: true,
          error: 'paid completion requires administrator review',
        });
        continue;
      }
      const { data: form, error: formError } = await supabase
        .from('form').select(FORM_COLUMNS).eq('id', submission.form_id)
        .eq('tenant_id', row.tenant_id).maybeSingle();
      if (formError || !form) throw formError || new Error('Form not found');
      await finalizeFormSubmission({
        supabase,
        submission,
        form,
        baseUrl: await resolveBaseUrl(row.tenant_id),
        deadlineAt,
      });
      const { data: ready, error: readyError } = await supabase
        .from('form_due_diligence_one_off_ready').select('form_submission_id')
        .eq('form_submission_id', row.form_submission_id).eq('tenant_id', row.tenant_id).maybeSingle();
      if (readyError || !ready) throw readyError || new Error('One-off DD readiness was not recorded');
      succeeded = true;
    } catch (err) {
      failure = err;
    }
    const { error: finishError } = await supabase.rpc('finish_missing_one_off_form_due_diligence_ready', {
      p_tenant_id: row.tenant_id,
      p_submission_id: row.form_submission_id,
      p_lease_token: row.lease_token,
      p_succeeded: succeeded,
      p_error: failure?.message || null,
    });
    if (finishError) throw finishError;
    outcomes.push({ submissionId: row.form_submission_id, succeeded, error: failure?.message || null });
  }
  return { outcomes, requiresAttention: attentionRows || [] };
}

export async function reconcileFormPayments(supabase, {
  baseUrl = null,
  limit = 50,
  retrievePaymentIntent = retrieveTenantPaymentIntent,
  timeBudgetMs = FORM_PAYMENT_COMPLETION_BUDGET_MS,
} = {}) {
  const results = { checked: 0, paid: 0, failed: 0, finalized: 0, errors: [] };
  const now = Date.now();
  // This is deliberately a wall-clock budget, not a Promise.race around
  // side-effects. Racing a provider call would leave it running after the
  // lease was released and could cause another worker to repeat an ambiguous
  // operation. We only start a new durable stage while enough time remains.
  const deadlineAt = now + Math.max(5_000, Number(timeBudgetMs) || FORM_PAYMENT_COMPLETION_BUDGET_MS);
  const hasBudget = () => Date.now() < deadlineAt;
  const minCreated = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const maxCreated = new Date(now - MIN_AGE_MS).toISOString();

  // One sweep spans tenants, so resolve and cache each trusted tenant URL.
  // An explicit caller-supplied request URL still wins.
  const baseUrlCache = new Map();
  const resolveBaseUrl = async (tenantId) => {
    if (baseUrl) return baseUrl;
    if (!tenantId) return null;
    if (!baseUrlCache.has(tenantId)) {
      baseUrlCache.set(tenantId, await getTrustedBaseUrlForTenant(null, supabase, tenantId));
    }
    return baseUrlCache.get(tenantId);
  };
  const formCache = new Map();
  const loadForm = async (formId, tenantId) => {
    const key = `${tenantId}:${formId}`;
    if (!formCache.has(key)) {
      const { data, error } = await supabase
        .from('form')
        .select(FORM_COLUMNS)
        .eq('id', formId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error) throw error;
      formCache.set(key, data || null);
    }
    return formCache.get(key);
  };

  // Address evidence is a prerequisite for Stripe completion, not best-effort
  // tail work. Serve one bounded retry before the completion queue so a paid
  // row missing its snapshot cannot be skipped forever behind slow provider
  // polling or DD reconciliation.
  await sweepStripeAddressPrerequisites();

  // Completion receipts are the first service class in every bounded run.
  // Pending-provider polling and DD recovery can make slow network calls; if
  // either comes first it can consume the whole slice and starve already-paid
  // submissions indefinitely. Claiming is fair and advances retry scheduling,
  // so serve this queue before any unrelated sweep.
  try {
    const { data: unfinalized, error } = await supabase
      .rpc('claim_form_payment_completion_retries', { p_limit: 20 });
    if (error) throw error;
    for (const row of unfinalized || []) {
      if (!hasBudget()) {
        results.budgetExhausted = true;
        break;
      }
      const addressRequired = row.payment_provider === 'stripe' && (
        !!row.payment_meta?.membership
        || row.payment_meta?.stripe_address_mapping_config?.mappings?.length > 0
      );
      if (addressRequired && !row.payment_meta?.stripe_billing_address) continue;
      const form = await loadForm(row.form_id, row.tenant_id);
      if (!hasFormPaymentAccessProof(row, form)) continue;
      const fin = await finalizeFormSubmission({
        supabase,
        submission: row,
        form,
        baseUrl: await resolveBaseUrl(row.tenant_id),
        deadlineAt,
      });
      if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Priority completion sweep failed:', err?.message);
    recordMonitoringFailure(results, 'priority-unfinalized-sweep', err);
  }

  // Restore missing one-off readiness before DD's independent sweep; until
  // then the DD SQL gate intentionally cannot claim the paid submission.
  try {
    const readiness = await recoverMissingOneOffDueDiligenceReadiness(supabase, {
      resolveBaseUrl, limit, deadlineAt,
    });
    if (readiness.requiresAttention.length || readiness.outcomes.some(row => !row.succeeded)) {
      recordMonitoringFailure(results, 'due-diligence-readiness-recovery', new Error('One or more readiness recoveries failed'));
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] One-off DD readiness recovery failed:', err?.message);
    recordMonitoringFailure(results, 'due-diligence-readiness-recovery', err);
  }

  // DD has its own prospective marker and retry state. Sweep it before the
  // payment-provider queries so an unrelated provider query failure or a
  // financial finalization stamp cannot suppress DD recovery.
  try {
    const dueDiligenceResult = await reconcilePaidFormDueDiligence({
      db: supabase,
      limit,
      deadlineAt,
      shouldSkipSubmission: async (row) => {
        const { data: submission, error } = await supabase
          .from('form_submission')
          .select('payment_meta')
          .eq('id', row.form_submission_id)
          .eq('tenant_id', row.tenant_id)
          .maybeSingle();
        if (error) throw error;
        // Non-terminal v1 receipts are managed by the paid completion lease.
        // Durable done is intentionally eligible: its readiness marker may
        // have failed transiently before an older owner recorded completion.
        // Receiptless historical rows retain their established DD recovery.
        return Number(submission?.payment_meta?.completion?.version) === 1
          && submission.payment_meta?.completion?.status !== 'done';
      },
    });
    // The helper deliberately converts its own database failures into an
    // outcome so payment reconciliation remains independent. Still expose
    // those failures to the cron heartbeat just as we do thrown sweep errors.
    if (!dueDiligenceResult?.ok) {
      recordMonitoringFailure(
        results,
        'due-diligence-sweep',
        new Error(dueDiligenceResult?.error || dueDiligenceResult?.code || 'Due diligence reconciliation failed'),
      );
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Due diligence sweep failed:', err?.message);
    recordMonitoringFailure(results, 'due-diligence-sweep', err);
  }

  let rows = [];
  try {
    const { data, error } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_status', 'pending')
      .or('payment_reference.not.is.null,payment_provider.eq.gocardless_monthly_dd')
      .gte('created_date', minCreated)
      .lte('created_date', maxCreated)
      .order('created_date', { ascending: true })
      .limit(limit);
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    // Pre-migration DB (42703) or transient failure — nothing to do.
    console.warn('[formPaymentReconciliation] Pending sweep query failed:', err?.message);
    recordMonitoringFailure(results, 'pending-payment-sweep', err);
    return results;
  }

  const processMonthlyDirectDebitRow = async (row) => {
    const agreementId = row.payment_meta?.monthly_direct_debit?.agreement_id || null;
    const { data: agreement, error: agreementError } = await findFormMonthlyDirectDebitAgreement(
      supabase,
      {
        tenantId: row.tenant_id,
        submissionId: row.id,
        agreementId,
      },
    );
    if (agreementError) throw agreementError;
    if (!agreement) return { handled: false, detail: 'monthly Direct Debit agreement not found' };
    let currentRow = row;
    if (row.payment_status === 'pending'
        && agreement.gocardless_billing_request_id
        && agreement.gocardless_billing_request_flow_id
        && (
          row.payment_reference !== agreement.gocardless_billing_request_id
          || row.payment_meta?.monthly_direct_debit?.agreement_id !== agreement.id
        )) {
      currentRow = await persistMonthlyDirectDebitLink(
        supabase,
        row,
        row.payment_meta?.monthly_direct_debit?.offer || null,
        agreement,
      );
    }
    const billingRequestId = currentRow.payment_reference
      || currentRow.payment_meta?.monthly_direct_debit?.billing_request_id
      || agreement.gocardless_billing_request_id
      || null;
    if (!billingRequestId) {
      return { handled: false, detail: 'monthly Direct Debit Billing Request not found' };
    }
    const gc = await gocardlessForTenant(currentRow.tenant_id);
    if (!gc.isConfigured()) {
      return { handled: false, detail: 'GoCardless is not configured for the tenant' };
    }
    const remainingMs = deadlineAt - Date.now() - 2_000;
    if (remainingMs < 1_000) throw new Error('worker budget exhausted before GoCardless Billing Request retrieval');
    const billingRequest = await gc.getBillingRequest(billingRequestId, {
      timeoutMs: Math.min(15_000, remainingMs),
    });
    const metadata = billingRequest?.metadata || {};
    if (metadata.type !== 'form_monthly_direct_debit'
        || metadata.form_submission_id !== String(currentRow.id)
        || metadata.agreement_id !== String(agreement.id)) {
      return { handled: false, detail: 'monthly Direct Debit provider metadata mismatch' };
    }
    if (billingRequest.status === 'cancelled' || billingRequest.status === 'failed') {
      const { error } = await supabase
        .from('form_submission')
        .update({ payment_status: 'failed' })
        .eq('id', currentRow.id)
        .in('payment_status', ['pending', 'setup_complete']);
      if (error) throw error;
      return { handled: true, failed: true, detail: `Billing Request ${billingRequest.status}` };
    }
    if (billingRequest.status !== 'fulfilled') {
      return { handled: false, pending: true, detail: `Billing Request ${billingRequest.status}` };
    }
    return processGocardlessEvent({
      id: `form-reconcile-${billingRequest.id}`,
      resource_type: 'billing_requests',
      action: 'fulfilled',
      links: {
        billing_request: billingRequest.id,
        mandate_request_mandate: billingRequest.links?.mandate_request_mandate || null,
        customer: billingRequest.links?.customer || null,
        payment_request_payment: billingRequest.links?.payment_request_payment || null,
      },
    }, {
      db: supabase,
      gc,
      baseUrl: await resolveBaseUrl(currentRow.tenant_id),
      deadlineAt,
    });
  };

  for (const row of rows) {
    if (!hasBudget()) {
      results.budgetExhausted = true;
      break;
    }
    results.checked += 1;
    try {
      const form = await loadForm(row.form_id, row.tenant_id);
      // Async reconciliation cannot evaluate a member session. A restricted
      // form therefore needs the durable proof written at payment start (or
      // by an eligible member's legacy browser confirmation).
      if (!hasFormPaymentAccessProof(row, form)) continue;
      if (row.payment_provider === 'stripe') {
        const stripeFeature = row.payment_meta?.stripe_feature
          || (row.payment_meta?.membership ? 'membership' : 'forms');
        const stripeTimeoutMs = Math.max(1_000, Math.min(12_000, deadlineAt - Date.now() - 2_000));
        if (deadlineAt - Date.now() < 3_000) {
          results.budgetExhausted = true;
          break;
        }
        const found = await retrievePaymentIntent(
          row.tenant_id,
          stripeFeature,
          row.payment_reference,
          { timeoutMs: stripeTimeoutMs },
        );
        if (!found) continue;
        const pi = found.paymentIntent;
        const metadataMatches = pi.metadata?.type === 'form_payment'
          && pi.metadata?.form_submission_id === String(row.id)
          && pi.metadata?.form_id === String(row.form_id)
          && pi.metadata?.tenant_id === String(row.tenant_id);
        if (!metadataMatches || row.payment_reference !== pi.id) continue;
        if (pi.status === 'succeeded') {
          if (row.payment_meta?.membership?.quote) {
            const immutableQuote = row.payment_meta.membership.quote;
            const expectedCurrency = String(immutableQuote.currency || row.payment_currency || '').toLowerCase();
            const expectedMinor = formMembershipQuoteAmountMinor(immutableQuote);
            const receivedMinor = Number(pi.amount_received ?? pi.amount);
            if (!expectedCurrency || pi.currency !== expectedCurrency
                || !Number.isFinite(expectedMinor) || receivedMinor !== expectedMinor) {
              throw new Error('Stripe PaymentIntent amount/currency does not match the immutable membership quote');
            }
          }
          const receivedMinor = pi.amount_received ?? pi.amount;
          // Browser confirmation writes this obligation before the paid CAS.
          // Reconciliation must preserve the same crash-safe ordering when it
          // is the first observer of a successful PaymentIntent.
          let queuedMeta;
          try {
            queuedMeta = await queueFormPaymentCompletion(supabase, row);
          } catch (queueError) {
            throw new Error(`completion receipt could not be queued: ${queueError?.message || 'unknown error'}`);
          }
          const { updated, row: paidRow } = await markFormSubmissionPaid(supabase, row.id, {
            amount: receivedMinor != null ? receivedMinor / 100 : null,
            reference: pi.id,
          });
          if (updated) results.paid += 1;
          // Preserve paid first. Address capture is a post-payment,
          // retryable obligation and must never leave a successful charge in
          // pending (where a user could be invited to pay again).
          const currentRow = {
            ...(paidRow || { ...row, payment_status: 'paid', payment_reference: pi.id }),
            payment_meta: paidRow?.payment_meta || queuedMeta,
          };
          const needsStripeAddress = !!currentRow.payment_meta?.membership
            || (currentRow.payment_meta?.stripe_address_mapping_config?.mappings?.length > 0);
          if (needsStripeAddress && !currentRow.payment_meta?.stripe_billing_address) {
            const billingAddress = await capturePaymentIntentBillingAddress({
              stripe: found.stripe,
              paymentIntent: pi,
              requireCustomer: !!currentRow.payment_meta?.membership,
            });
            currentRow.payment_meta = await captureFormStripeBillingAddressOnce({
              db: supabase,
              tenantId: row.tenant_id,
              submissionId: row.id,
              address: billingAddress,
            });
          }
          if (form) {
            const fin = await finalizeFormSubmission({
              supabase,
              submission: currentRow,
              form,
              baseUrl: await resolveBaseUrl(row.tenant_id),
              deadlineAt,
            });
            if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
          }
        } else if (pi.status === 'canceled') {
          await supabase.from('form_submission')
            .update({ payment_status: 'failed' })
            .eq('id', row.id).eq('payment_status', 'pending');
          results.failed += 1;
        }
      } else if (row.payment_provider === 'gocardless_monthly_dd') {
        const outcome = await processMonthlyDirectDebitRow(row);
        if (outcome.failed) results.failed += 1;
        if (outcome.handled && !outcome.failed) results.finalized += 1;
      } else if (row.payment_provider === 'gocardless') {
        const gc = await gocardlessForTenant(row.tenant_id);
        if (!gc.isConfigured()) continue;
        const remainingMs = deadlineAt - Date.now() - 2_000;
        if (remainingMs < 1_000) {
          results.budgetExhausted = true;
          break;
        }
        const br = await gc.getBillingRequest(row.payment_reference, {
          timeoutMs: Math.min(15_000, remainingMs),
        });
        const brMeta = br?.metadata || {};
        if (brMeta.type !== 'form_payment' || brMeta.form_submission_id !== String(row.id)) continue;
        if (br.status === 'fulfilled') {
          const { updated, row: paidRow } = await markFormSubmissionPaid(supabase, row.id, { reference: br.id });
          if (updated) results.paid += 1;
          if (form) {
            const fin = await finalizeFormSubmission({
              supabase,
              submission: paidRow || { ...row, payment_status: 'paid' },
              form,
              baseUrl: await resolveBaseUrl(row.tenant_id),
              deadlineAt,
            });
            if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
          }
        } else if (br.status === 'cancelled' || br.status === 'failed') {
          await supabase.from('form_submission')
            .update({ payment_status: 'failed' })
            .eq('id', row.id).eq('payment_status', 'pending');
          results.failed += 1;
        }
      }
    } catch (err) {
      console.error(`[formPaymentReconciliation] Row ${row.id} failed:`, err?.message);
      results.errors.push({ id: row.id, error: err?.message });
    }
  }

  // Compatibility sweep: the v1 retry table deliberately has no migration
  // backfill. Recover the bounded set of historical Stripe rows and
  // GoCardless rows which crashed after mark-paid but before legacy
  // finalization. A paid status alone is never evidence of completion: retain
  // every completed historical row by requiring the actual finalized stamp to
  // be absent. Do not queue a v1 receipt here; this preserves the historical
  // completion protocol rather than silently changing its audit history.
  try {
    const { data: legacyUnfinalized, error } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_status', 'paid')
      .or('payment_provider.eq.stripe,payment_provider.eq.gocardless')
      .filter('payment_meta->finalized', 'is', null)
      .or('payment_meta->completion->>version.is.null,payment_meta->completion->>version.neq.1')
      .order('created_date', { ascending: true })
      .order('id', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of legacyUnfinalized || []) {
      if (!hasBudget()) {
        results.budgetExhausted = true;
        break;
      }
      const form = await loadForm(row.form_id, row.tenant_id);
      if (!hasFormPaymentAccessProof(row, form)) continue;
      const fin = await finalizeFormSubmission({
        supabase,
        submission: row,
        form,
        baseUrl: await resolveBaseUrl(row.tenant_id),
        deadlineAt,
      });
      if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Legacy unfinalized sweep failed:', err?.message);
    recordMonitoringFailure(results, 'legacy-unfinalized-sweep', err);
  }

  // Third sweep (Task #3489): paid + finalized rows carrying a conditional
  // membership quote whose membership work is incomplete AFTER the finalize
  // claim — either no membership_result stamp at all (transient failure /
  // crash before insert or stamp), or a 'created' stamp with a pending
  // invoice/workflow side effect (crash mid-way). finalizeFormMembership is
  // internally idempotent and resumable (payment-ref + (entity, year) +
  // ownership-marker adoption + per-side-effect states).
  // Deliberately NOT bounded by the 14-day payment lookback: a paid
  // submission with an unfinished membership must be retried until a
  // terminal stamp lands, however old it is. Oldest-first ordering makes
  // eventual service deterministic even when a backlog exceeds the limit.
  try {
    const { data: pendingMembership, error } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_status', 'paid')
      .not('payment_meta->membership->quote', 'is', null)
      .filter('payment_meta->finalized', 'not.is', null)
       // v1 receipts are exclusively owned by the fair completion lease.
       // Do not let this independent membership scan bypass a partial,
       // retryable, processing, or attention pipeline lifecycle.
       .or('payment_meta->completion->>version.is.null,payment_meta->completion->>version.neq.1')
      // Also recover orphaned workflow claims (crash between claim and
      // dispatch): 'claimed' with a claim timestamp past the TTL. ISO
      // strings compare lexicographically, so lt on the ->> text works.
      .or([
        'payment_meta->membership_result.is.null',
        'payment_meta->membership_result->>invoice_state.eq.pending',
        'payment_meta->membership_result->>invoice_state.eq.retry',
        `and(payment_meta->membership_result->>invoice_state.eq.processing,payment_meta->membership_result->>invoice_claimed_at.lt.${new Date(now - WORKFLOW_CLAIM_TTL_MS).toISOString()})`,
        'payment_meta->membership_result->>settlement_state.eq.pending',
        'payment_meta->membership_result->>settlement_state.eq.retry',
        `and(payment_meta->membership_result->>settlement_state.eq.processing,payment_meta->membership_result->>settlement_claimed_at.lt.${new Date(now - FORM_STRIPE_SETTLEMENT_CLAIM_TTL_MS).toISOString()})`,
        'payment_meta->membership_result->>workflow_state.eq.pending',
        'payment_meta->membership_result->>status.eq.awaiting_entity',
        `and(payment_meta->membership_result->>workflow_state.eq.claimed,payment_meta->membership_result->>workflow_claimed_at.lt.${new Date(now - WORKFLOW_CLAIM_TTL_MS).toISOString()})`,
      ].join(','))
      .order('created_date', { ascending: true })
      .order('id', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of pendingMembership || []) {
      // Defense in depth for PostgREST expression compatibility: a managed
      // v1 receipt must never run membership/accounting outside its owner-
      // fenced finalizeFormSubmission path.
      if (Number(row.payment_meta?.completion?.version) === 1) continue;
      if (!hasBudget()) {
        results.budgetExhausted = true;
        break;
      }
      const form = await loadForm(row.form_id, row.tenant_id);
      if (!hasFormPaymentAccessProof(row, form)) continue;
      // If the membership target entity is still unresolved (pipeline
      // failed or never ran to completion), re-run the form's entity
      // pipelines first — the same operation an admin performs via
      // "Re-run processing"; process-application matches/updates existing
      // records for the same submission, so retries resolve the ids
      // rather than duplicating entities.
      const target = row.payment_meta?.membership?.quote?.target;
      const entityMissing = target === 'member'
        ? !row.created_member_id
        : !(row.organization_id || row.payment_meta?.prefill_organization_id);
      const rowBaseUrl = await resolveBaseUrl(row.tenant_id);
      if (entityMissing && rowBaseUrl) {
        try {
          if (form) {
            const pipelineOut = await runFormEntityPipelines({
              supabase,
              submission: row,
              form,
              baseUrl: rowBaseUrl,
              deadlineAt,
              completionOperationId: randomUUID(),
            });
            if (pipelineOut.ambiguous) {
              // The operation reservation is now durable attention. Do not
              // advance membership/accounting from a processor result whose
              // side effects cannot be known.
              recordMonitoringFailure(
                results,
                'membership-pipeline-rerun',
                new Error(pipelineOut.detail || 'pipeline outcome requires administrator review'),
              );
              continue;
            }
            if (pipelineOut.memberId) row.created_member_id = row.created_member_id || pipelineOut.memberId;
            if (pipelineOut.organizationId) row.organization_id = row.organization_id || pipelineOut.organizationId;
          }
        } catch (err) {
          console.warn('[formPaymentReconciliation] Pipeline re-run failed for', row.id, err?.message);
          recordMonitoringFailure(results, 'membership-pipeline-rerun', err);
        }
      }
      const out = await finalizeFormMembership({
        supabase, submission: row, baseUrl: rowBaseUrl, deadlineAt,
      });
      if (out?.created) results.membershipCreated = (results.membershipCreated || 0) + 1;
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Membership retry sweep failed:', err?.message);
    recordMonitoringFailure(results, 'membership-retry-sweep', err);
  }

  // Retry incomplete Structured Record Actions and subordinate primary-pipeline
  // relationship links independently of membership creation. The application
  // processor persists both markers from the same signed, persisted-config run.
  try {
    const { data: pendingPipelineWork, error } = await supabase
      .from('form_submission')
      .select('*')
      .or('payment_status.eq.paid,payment_status.eq.setup_complete')
      .or('payment_meta->structured_actions_pending.eq.true,payment_meta->related_records_pending.eq.true')
      .or('payment_meta->completion->>status.is.null,payment_meta->completion->>status.neq.attention')
      .order('created_date', { ascending: true })
      .order('id', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of pendingPipelineWork || []) {
      if (!hasBudget()) {
        results.budgetExhausted = true;
        break;
      }
      const form = await loadForm(row.form_id, row.tenant_id);
      if (!form || !hasFormPaymentAccessProof(row, form)) continue;
      const rowBaseUrl = await resolveBaseUrl(row.tenant_id);
      if (!rowBaseUrl) continue;
      const pipelineOut = await runFormEntityPipelines({
        supabase,
        submission: row,
        form,
        baseUrl: rowBaseUrl,
        deadlineAt,
        completionOperationId: randomUUID(),
        completionOperationKind: 'followup',
      });
      if (pipelineOut.ambiguous) {
        // A timed-out/lost processor outcome is terminal for automated
        // processing. In particular, do not clear a pending marker merely
        // because an older response body is unavailable.
        recordMonitoringFailure(
          results,
          'structured-pipeline-rerun',
          new Error(pipelineOut.detail || 'pipeline outcome requires administrator review'),
        );
        continue;
      }
        const paymentMetaPatch = {};
      let shouldPersist = false;
      if (row.payment_meta?.structured_actions_pending && pipelineOut.structuredActions?.success) {
        paymentMetaPatch.structured_actions_pending = false;
        paymentMetaPatch.structured_actions_result = pipelineOut.structuredActions;
        results.structuredActionsReconciled = (results.structuredActionsReconciled || 0) + 1;
        shouldPersist = true;
      }
      if (row.payment_meta?.related_records_pending && pipelineOut.relatedRecords?.success) {
        paymentMetaPatch.related_records_pending = false;
        paymentMetaPatch.related_records_result = pipelineOut.relatedRecords;
        results.relatedRecordsReconciled = (results.relatedRecordsReconciled || 0) + 1;
        shouldPersist = true;
      }
      if (shouldPersist) {
        await patchFormSubmissionPaymentMeta({
          db: supabase,
          tenantId: row.tenant_id,
          submissionId: row.id,
          patch: paymentMetaPatch,
        });
      }
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Structured/Related Records retry sweep failed:', err?.message);
    recordMonitoringFailure(results, 'structured-related-records-retry-sweep', err);
  }

  // Fourth sweep (Task #3680): form_submission rows with
  // payment_provider='stripe_monthly_card' and payment_status='setup_complete'
  // whose finalisation is incomplete. Selects rows where monthly_card_state is:
  //   - absent (null)        — no attempt has run yet (crash before claim)
  //   - processing + stale   — active lease expired (process crash)
  //   - retryable            — prior owner persisted an actionable failure
  // Rows with a fresh 'processing' lease are skipped (the active holder will
  // stamp 'done' or release on failure). Rows already at 'done' are excluded.
  // Deliberately NOT bounded by the payment lookback: like the third sweep,
  // an unfinished setup_complete row must be retried until complete however
  // old it is. Oldest-first ordering makes progress deterministic.
  try {
    const staleCutoff = new Date(now - FINALIZE_CLAIM_TTL_MS).toISOString();
    const { data: setupCompleteRows, error } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_provider', 'stripe_monthly_card')
      .eq('payment_status', 'setup_complete')
      .or([
        'payment_meta->monthly_card_state.is.null',
        'payment_meta->monthly_card_state->>status.eq.retryable',
        `and(payment_meta->monthly_card_state->>status.eq.processing,payment_meta->monthly_card_state->>claimed_at.lt.${staleCutoff})`,
      ].join(','))
      .order('created_date', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of setupCompleteRows || []) {
      if (!hasBudget()) {
        results.budgetExhausted = true;
        break;
      }
      try {
        const form = await loadForm(row.form_id, row.tenant_id);
        if (!hasFormPaymentAccessProof(row, form)) continue;
        // Load the associated billing agreement via the agreement_id stored in
        // payment_meta.monthly_card.agreement_id (set at checkout creation time).
        const agreementId = row.payment_meta?.monthly_card?.agreement_id || null;
        const { data: agreement, error: agreementError } = await findFormMonthlyCardAgreement(supabase, {
          tenantId: row.tenant_id,
          submissionId: row.id,
          agreementId,
        });
        if (agreementError) throw agreementError;
        if (!agreement) continue;
        const rowBaseUrl = await resolveBaseUrl(row.tenant_id);
        await finalizeFormMonthlyCardCheckout({
          db: supabase,
          agreement,
          session: { metadata: { form_submission_id: row.id } },
          baseUrl: rowBaseUrl,
        });
      } catch (err) {
        console.warn('[formPaymentReconciliation] Monthly-card setup_complete retry failed for', row.id, err?.message);
        recordMonitoringFailure(results, 'monthly-card-retry', err);
      }
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Monthly-card setup_complete sweep failed:', err?.message);
    recordMonitoringFailure(results, 'monthly-card-retry-sweep', err);
  }

  // Fifth sweep: a fulfilled monthly-DD Billing Request may have reached
  // setup_complete before the member pipeline/history binding finished.
  // Replay the same Billing Request event path used by browser confirmation
  // and webhooks so member binding always precedes subscription creation.
  try {
    const staleCutoff = new Date(now - DD_FINALIZE_CLAIM_TTL_MS).toISOString();
    const { data: setupCompleteRows, error } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_provider', 'gocardless_monthly_dd')
      .eq('payment_status', 'setup_complete')
      .or([
        'payment_meta->monthly_dd_state.is.null',
        `and(payment_meta->monthly_dd_state->>status.eq.processing,payment_meta->monthly_dd_state->>claimed_at.lt.${staleCutoff})`,
      ].join(','))
      .order('created_date', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of setupCompleteRows || []) {
      if (!hasBudget()) {
        results.budgetExhausted = true;
        break;
      }
      try {
        const form = await loadForm(row.form_id, row.tenant_id);
        if (!hasFormPaymentAccessProof(row, form)) continue;
        const outcome = await processMonthlyDirectDebitRow(row);
        if (outcome.handled && !outcome.failed) results.finalized += 1;
      } catch (err) {
        console.warn('[formPaymentReconciliation] Monthly-DD setup_complete retry failed for', row.id, err?.message);
        recordMonitoringFailure(results, 'monthly-dd-retry', err);
      }
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Monthly-DD setup_complete sweep failed:', err?.message);
    recordMonitoringFailure(results, 'monthly-dd-retry-sweep', err);
  }

  // Address fulfilment is deliberately independent of the ordinary
  // finalization stamp. A payment can be paid/finalized while Stripe address
  // retrieval, the snapshot write, or the atomic target-write RPC is
  // temporarily unavailable; keep replaying those obligations without age
  // bounds and without reopening the charge.
  async function sweepStripeAddressPrerequisites() {
    // Do not lease work which cannot safely start. Address retrieval can use
    // its complete provider timeout, then still needs durable snapshot/finish
    // writes before this bounded invocation ends.
    const canStartAddressAttempt = () => deadlineAt - Date.now() >= 15_000;
    if (!canStartAddressAttempt()) {
      results.budgetExhausted = true;
      return;
    }
    try {
    const { data: claimedAddressRows, error } = await supabase.rpc(
      'claim_form_stripe_address_mapping_retries',
      { p_limit: 1 },
    );
    if (error) throw error;
    for (const claim of claimedAddressRows || []) {
      if (!canStartAddressAttempt()) {
        results.budgetExhausted = true;
        // The RPC lease is owner-fenced. Explicitly release a claim that
        // never began rather than leaving it unavailable for five minutes.
        const row = claim?.submission || claim;
        const { error: releaseError } = await supabase.rpc(
          'finish_form_stripe_address_mapping_retry',
          {
            p_tenant_id: row.tenant_id,
            p_submission_id: row.id,
            p_owner_token: claim?.lease_token || null,
            p_succeeded: false,
            p_error: 'worker budget exhausted before address retry started',
          },
        );
        if (releaseError) recordMonitoringFailure(results, 'stripe-address-mapping-retry-release', releaseError);
        break;
      }
      let row = claim?.submission || claim;
      const retryOwnerToken = claim?.lease_token || null;
      let retrySucceeded = false;
      let retryError = null;
      try {
        if (row.payment_provider === 'stripe_monthly_card'
            && !row.payment_meta?.stripe_billing_address) {
          const agreementId = row.payment_meta?.monthly_card?.agreement_id || null;
          const { data: agreement, error: agreementErr } = await findFormMonthlyCardAgreement(
            supabase,
            {
              tenantId: row.tenant_id,
              submissionId: row.id,
              agreementId,
            },
          );
          if (agreementErr) throw agreementErr;
          const address = agreement?.metadata?.stripe_billing_address;
          if (!address) throw new Error('monthly Stripe billing address snapshot is unavailable');
          const { data: savedMeta, error: snapshotError } = await supabase.rpc('capture_form_stripe_billing_address_once', {
            p_tenant_id: row.tenant_id,
            p_submission_id: row.id,
            p_address: address,
          });
          if (snapshotError || !savedMeta) throw new Error(snapshotError?.message || 'Stripe address snapshot was not recorded');
          row = { ...row, payment_meta: savedMeta };
        }
        if (row.payment_provider === 'stripe'
            && !row.payment_meta?.stripe_billing_address) {
          const addressStartedAt = Date.now();
          const stripeFeature = row.payment_meta?.stripe_feature
            || (row.payment_meta?.membership ? 'membership' : 'forms');
          const remainingMs = deadlineAt - Date.now() - 2_000;
          if (remainingMs < 1_000) throw new Error('worker budget exhausted before Stripe address retrieval');
          const found = await retrievePaymentIntent(
            row.tenant_id, stripeFeature, row.payment_reference,
            { timeoutMs: Math.min(12_000, remainingMs) },
          );
          const intent = found?.paymentIntent;
          const metadataMatches = intent?.metadata?.type === 'form_payment'
            && intent.metadata.form_submission_id === String(row.id)
            && intent.metadata.tenant_id === String(row.tenant_id);
          if (!found || intent.status !== 'succeeded'
              || (!metadataMatches && intent.id !== row.payment_reference)) {
            throw new Error('verified Stripe payment is unavailable for address retry');
          }
          const address = await capturePaymentIntentBillingAddress({
            stripe: found.stripe,
            paymentIntent: intent,
            requireCustomer: !!row.payment_meta?.membership,
          });
          const savedMeta = await captureFormStripeBillingAddressOnce({
            db: supabase,
            tenantId: row.tenant_id,
            submissionId: row.id,
            address,
          });
          row = { ...row, payment_meta: savedMeta };
          console.info('[formPaymentReconciliation] completion_timing', {
            submissionId: row.id,
            tenantId: row.tenant_id,
            stage: 'stripe_address_capture',
            durationMs: Date.now() - addressStartedAt,
            outcome: 'ok',
          });
        }
        const mappingsConfigured = row.payment_meta?.stripe_address_mapping_config?.mappings?.length > 0;
        if (mappingsConfigured) {
          const mappingResult = await retryPersistedStripeAddressMappings({
            db: supabase,
            submissionId: row.id,
            tenantId: row.tenant_id,
          });
          retrySucceeded = mappingResult?.applied === true || mappingResult?.alreadyApplied === true;
          if (!retrySucceeded) retryError = mappingResult?.reason || 'Stripe address mapping is still pending';
        } else {
          // Membership completion needs only the immutable snapshot; no target
          // mapping ledger is expected for forms without configured mappings.
          retrySucceeded = !!row.payment_meta?.stripe_billing_address;
        }
        // The RPC ledger makes every replay safe; no public cron-summary
        // counter is needed (and retaining the established response shape
        // keeps monitoring consumers backwards compatible).
      } catch (err) {
        retryError = err?.message;
        console.warn('[formPaymentReconciliation] Stripe address mapping retry failed for', row.id, err?.message);
        recordMonitoringFailure(results, 'stripe-address-mapping-retry', err);
      } finally {
        const { error: finishError } = await supabase.rpc(
          'finish_form_stripe_address_mapping_retry',
          {
            p_tenant_id: row.tenant_id,
            p_submission_id: row.id,
            p_owner_token: retryOwnerToken,
            p_succeeded: retrySucceeded,
            p_error: retryError,
          },
        );
        if (finishError) {
          console.warn('[formPaymentReconciliation] Stripe address retry release failed for', row.id, finishError.message);
          recordMonitoringFailure(results, 'stripe-address-mapping-retry-release', finishError);
        }
      }
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Stripe address mapping sweep failed:', err?.message);
    recordMonitoringFailure(results, 'stripe-address-mapping-retry-sweep', err);
  }
  }

  return results;
}
