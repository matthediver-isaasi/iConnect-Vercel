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
import { gocardlessForTenant } from './gocardless.js';
import { markFormSubmissionPaid, finalizeFormSubmission } from './formPaymentFinalize.js';
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

const FORM_COLUMNS = 'id, name, tenant_id, access_policy, fields, pages, visibility_rules, entity_pipelines, structured_actions, field_mappings, application_level, auto_create_entity, create_entity_type, entity_action, member_entity_action, organization_entity_action, additional_member_creations, default_member_role_id, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type';

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

export async function reconcileFormPayments(supabase, {
  baseUrl = null,
  limit = 50,
  retrievePaymentIntent = retrieveTenantPaymentIntent,
} = {}) {
  const results = { checked: 0, paid: 0, failed: 0, finalized: 0, errors: [] };
  const now = Date.now();
  const minCreated = new Date(now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const maxCreated = new Date(now - MIN_AGE_MS).toISOString();

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

  // Task #3502: finalisation runs the form's entity pipelines via an
  // internal HTTP call and silently skips them without a baseUrl. The cron
  // caller has no request to derive an origin from, and one sweep spans
  // tenants — so resolve the trusted base URL per tenant (cached). An
  // explicit caller-supplied baseUrl (request-derived) still wins.
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
    const billingRequest = await gc.getBillingRequest(billingRequestId);
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
    });
  };

  for (const row of rows) {
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
        const found = await retrievePaymentIntent(row.tenant_id, stripeFeature, row.payment_reference);
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
          const { updated, row: paidRow } = await markFormSubmissionPaid(supabase, row.id, {
            amount: receivedMinor != null ? receivedMinor / 100 : null,
            reference: pi.id,
          });
          if (updated) results.paid += 1;
          // Preserve paid first. Address capture is a post-payment,
          // retryable obligation and must never leave a successful charge in
          // pending (where a user could be invited to pay again).
          const currentRow = paidRow || { ...row, payment_status: 'paid', payment_reference: pi.id };
          const needsStripeAddress = !!currentRow.payment_meta?.membership
            || (currentRow.payment_meta?.stripe_address_mapping_config?.mappings?.length > 0);
          if (needsStripeAddress && !currentRow.payment_meta?.stripe_billing_address) {
            const billingAddress = await capturePaymentIntentBillingAddress({
              stripe: found.stripe,
              paymentIntent: pi,
              requireCustomer: !!currentRow.payment_meta?.membership,
            });
            currentRow.payment_meta = await patchFormSubmissionPaymentMeta({
              db: supabase,
              tenantId: row.tenant_id,
              submissionId: row.id,
              patch: { stripe_billing_address: billingAddress },
            });
          }
          if (form) {
            const fin = await finalizeFormSubmission({
              supabase,
              submission: currentRow,
              form,
              baseUrl: await resolveBaseUrl(row.tenant_id),
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
        const br = await gc.getBillingRequest(row.payment_reference);
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

  // Second sweep: paid rows whose finalisation never completed.
  try {
    const { data: unfinalized, error } = await supabase
      .from('form_submission')
      .select('*')
      .eq('payment_status', 'paid')
      .gte('created_date', minCreated)
      .filter('payment_meta->finalized', 'is', null)
      .limit(20);
    if (error) throw error;
    for (const row of unfinalized || []) {
      const addressRequired = row.payment_provider === 'stripe' && (
        !!row.payment_meta?.membership
        || row.payment_meta?.stripe_address_mapping_config?.mappings?.length > 0
      );
      // Do not claim ordinary finalization from a stale metadata snapshot
      // while the address retry sweep still owes the authoritative snapshot.
      if (addressRequired && !row.payment_meta?.stripe_billing_address) continue;
      const form = await loadForm(row.form_id, row.tenant_id);
      if (!hasFormPaymentAccessProof(row, form)) continue;
      const fin = await finalizeFormSubmission({ supabase, submission: row, form, baseUrl: await resolveBaseUrl(row.tenant_id) });
      if (fin.finalized && !fin.alreadyFinalized) results.finalized += 1;
    }
  } catch (err) {
    console.warn('[formPaymentReconciliation] Unfinalized sweep failed:', err?.message);
    recordMonitoringFailure(results, 'unfinalized-sweep', err);
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
            const pipelineOut = await runFormEntityPipelines({ supabase, submission: row, form, baseUrl: rowBaseUrl });
            if (pipelineOut.memberId) row.created_member_id = row.created_member_id || pipelineOut.memberId;
            if (pipelineOut.organizationId) row.organization_id = row.organization_id || pipelineOut.organizationId;
          }
        } catch (err) {
          console.warn('[formPaymentReconciliation] Pipeline re-run failed for', row.id, err?.message);
          recordMonitoringFailure(results, 'membership-pipeline-rerun', err);
        }
      }
      const out = await finalizeFormMembership({ supabase, submission: row, baseUrl: rowBaseUrl });
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
      .order('created_date', { ascending: true })
      .order('id', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of pendingPipelineWork || []) {
      const form = await loadForm(row.form_id, row.tenant_id);
      if (!form || !hasFormPaymentAccessProof(row, form)) continue;
      const rowBaseUrl = await resolveBaseUrl(row.tenant_id);
      if (!rowBaseUrl) continue;
      const pipelineOut = await runFormEntityPipelines({
        supabase,
        submission: row,
        form,
        baseUrl: rowBaseUrl,
      });
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
  //   - not 'done'           — any other non-terminal state
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
        `and(payment_meta->monthly_card_state->>status.eq.processing,payment_meta->monthly_card_state->>claimed_at.lt.${staleCutoff})`,
      ].join(','))
      .order('created_date', { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const row of setupCompleteRows || []) {
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
  try {
    const { data: claimedAddressRows, error } = await supabase.rpc(
      'claim_form_stripe_address_mapping_retries',
      { p_limit: 20 },
    );
    if (error) throw error;
    for (const claim of claimedAddressRows || []) {
      let row = claim?.submission || claim;
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
          const savedMeta = await patchFormSubmissionPaymentMeta({
            db: supabase,
            tenantId: row.tenant_id,
            submissionId: row.id,
            patch: { stripe_billing_address: address },
          });
          row = { ...row, payment_meta: savedMeta };
        }
        if (row.payment_provider === 'stripe'
            && !row.payment_meta?.stripe_billing_address) {
          const stripeFeature = row.payment_meta?.stripe_feature
            || (row.payment_meta?.membership ? 'membership' : 'forms');
          const found = await retrievePaymentIntent(
            row.tenant_id, stripeFeature, row.payment_reference,
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
          const savedMeta = await patchFormSubmissionPaymentMeta({
            db: supabase,
            tenantId: row.tenant_id,
            submissionId: row.id,
            patch: { stripe_billing_address: address },
          });
          row = { ...row, payment_meta: savedMeta };
        }
        const mappingResult = await retryPersistedStripeAddressMappings({
          db: supabase,
          submissionId: row.id,
          tenantId: row.tenant_id,
        });
        retrySucceeded = mappingResult?.applied === true || mappingResult?.alreadyApplied === true;
        if (!retrySucceeded) retryError = mappingResult?.reason || 'Stripe address mapping is still pending';
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

  return results;
}
