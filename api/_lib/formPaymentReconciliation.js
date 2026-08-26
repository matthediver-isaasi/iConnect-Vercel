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

const FORM_COLUMNS = 'id, name, tenant_id, access_policy, fields, pages, visibility_rules, entity_pipelines, field_mappings, application_level, submission_emails, submission_email_template_id, submission_email_recipient, submission_email_cc, submission_email_bcc, submission_email_field_mapping, form_type';

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

export async function reconcileFormPayments(supabase, { baseUrl = null, limit = 50 } = {}) {
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
      .not('payment_reference', 'is', null)
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

  for (const row of rows) {
    results.checked += 1;
    try {
      const form = await loadForm(row.form_id, row.tenant_id);
      // Async reconciliation cannot evaluate a member session. A restricted
      // form therefore needs the durable proof written at payment start (or
      // by an eligible member's legacy browser confirmation).
      if (!hasFormPaymentAccessProof(row, form)) continue;
      if (row.payment_provider === 'stripe') {
        const found = await retrieveTenantPaymentIntent(row.tenant_id, 'forms', row.payment_reference);
        if (!found) continue;
        const pi = found.paymentIntent;
        const metadataMatches = pi.metadata?.type === 'form_payment'
          && pi.metadata?.form_submission_id === String(row.id)
          && pi.metadata?.tenant_id === String(row.tenant_id);
        if (!metadataMatches && row.payment_reference !== pi.id) continue;
        if (pi.status === 'succeeded') {
          const receivedMinor = pi.amount_received ?? pi.amount;
          const { updated, row: paidRow } = await markFormSubmissionPaid(supabase, row.id, {
            amount: receivedMinor != null ? receivedMinor / 100 : null,
            reference: pi.id,
          });
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
        } else if (pi.status === 'canceled') {
          await supabase.from('form_submission')
            .update({ payment_status: 'failed' })
            .eq('id', row.id).eq('payment_status', 'pending');
          results.failed += 1;
        }
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

  return results;
}
