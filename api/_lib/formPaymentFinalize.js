/**
 * Form payment finalisation (Task #3483).
 *
 * markFormSubmissionPaid: race-proof compare-and-set of a pending-payment
 * form_submission row to 'paid'. Exactly ONE caller (browser confirm,
 * GoCardless return leg, webhook, or the reconciliation cron) wins the CAS
 * and runs the post-submission side effects; every other caller sees
 * updated=false and treats the payment as already handled.
 *
 * finalizeFormSubmission: runs the "usual" post-submission processing for a
 * paid row — entity pipelines / field mappings (via the same internal
 * /api/forms/process-application call the normal submit path uses) and the
 * configured submission emails (already exactly-once via the atomic
 * submission_email_state claim). Failures are logged, never thrown: the
 * paid row is durable and the reconciliation cron retries finalisation for
 * rows whose payment_meta lacks `finalized`.
 */
import { sendSubmissionEmailsGuarded } from './formSubmissionEmails.js';
import { finalizeFormMembership } from './formMembershipFinalize.js';
import { runFormEntityPipelines } from './formEntityPipelines.js';
import { initializePaidFormDueDiligence } from './formDueDiligence.js';

// Due-diligence initialization is a separately retryable post-payment
// obligation. It must never reopen or prevent the financial finalization
// claim, including if an unexpected integration failure escapes its
// intentionally nonthrowing helper.
async function initializeDueDiligenceSafely(supabase, submission) {
  try {
    return await initializePaidFormDueDiligence({
      db: supabase,
      submissionId: submission.id,
      tenantId: submission.tenant_id,
    });
  } catch (err) {
    console.error(
      '[formPaymentFinalize] Due diligence initialization failed for',
      submission.id,
      err?.message,
    );
    return { ok: false, code: 'INITIALIZATION_INTERRUPTED', error: err?.message };
  }
}

// The paid DD marker is intentionally separate from payment_meta. Financial
// finalizers can update payment metadata concurrently, while this marker is
// written only after entity processing and membership binding have both
// succeeded.
async function markOneOffDueDiligenceReady(supabase, submission) {
  const { data, error } = await supabase.rpc('mark_one_off_form_due_diligence_ready', {
    p_tenant_id: submission.tenant_id,
    p_submission_id: submission.id,
  });
  if (error) throw error;
  if (data !== true) throw new Error('One-off due-diligence readiness marker was not recorded');
}

/**
 * CAS pending -> paid. Returns { updated, row }.
 */
export async function markFormSubmissionPaid(supabase, submissionId, {
  amount = null,
  currency = null,
  reference = null,
} = {}) {
  const update = {
    payment_status: 'paid',
    payment_paid_at: new Date().toISOString(),
  };
  if (amount != null) update.payment_amount = amount;
  if (currency) update.payment_currency = currency;
  if (reference) update.payment_reference = reference;

  const { data, error } = await supabase
    .from('form_submission')
    .update(update)
    .eq('id', submissionId)
    .eq('payment_status', 'pending')
    .select()
    .maybeSingle();
  if (error) {
    console.error('[formPaymentFinalize] CAS update failed:', error);
    throw new Error('Failed to record payment on submission');
  }
  return { updated: !!data, row: data || null };
}

/**
 * Post-payment side effects. Idempotent-ish: pipeline processing is guarded
 * by a `finalized` stamp in payment_meta (set BEFORE side effects run via
 * CAS so two concurrent finalizers can't both run pipelines), and emails
 * are exactly-once via sendSubmissionEmailsGuarded.
 *
 * @param {object} args - { supabase, submission, form, baseUrl }
 */
export async function finalizeFormSubmission({ supabase, submission, form, baseUrl }) {
  if (!submission?.id || !form) return { finalized: false };

  // Claim finalisation: CAS on payment_meta.finalized so the browser
  // confirm and the cron can't both run pipelines.
  const meta = (submission.payment_meta && typeof submission.payment_meta === 'object')
    ? submission.payment_meta : {};
  let resumingUnreadyFinalization = false;
  if (meta.finalized) {
    // A prior worker may have completed financial finalization before the DD
    // obligation was introduced. A ready row only needs DD recovery; an
    // unready prospective row must first retry the idempotent entity and
    // membership work that gates the readiness marker.
    const ddOutcome = await initializeDueDiligenceSafely(supabase, submission);
    if (ddOutcome?.code !== 'ONE_OFF_NOT_READY') {
      return { finalized: true, alreadyFinalized: true };
    }
    resumingUnreadyFinalization = true;
  }
  if (!resumingUnreadyFinalization) {
    const { data: claimed, error: claimErr } = await supabase
      .from('form_submission')
      .update({ payment_meta: { ...meta, finalized: true, finalized_at: new Date().toISOString() } })
      .eq('id', submission.id)
      .eq('payment_status', 'paid')
      .eq('payment_meta', JSON.stringify(meta))
      .filter('payment_meta->finalized', 'is', null)
      .select('id')
      .maybeSingle();
    if (claimErr) {
      console.error('[formPaymentFinalize] Finalize claim failed:', claimErr);
      return { finalized: false };
    }
    if (!claimed) {
      const { data: fresh, error: freshErr } = await supabase
        .from('form_submission')
        .select('*')
        .eq('id', submission.id)
        .maybeSingle();
      if (freshErr || !fresh) return { finalized: false };
      if (fresh.payment_meta?.finalized) {
        return { finalized: true, alreadyFinalized: true };
      }
      // A sibling metadata key changed between read and claim. Retry from the
      // exact fresh snapshot rather than replacing that key.
      return finalizeFormSubmission({
        supabase,
        submission: fresh,
        form,
        baseUrl,
      });
    }
  }

  // Entity pipelines / field mappings — same internal call as the normal
  // submit path, via the shared runner (also used by the reconciliation
  // cron to re-run processing when the membership target entity is still
  // unresolved). Unlike the normal path we never roll the row back: the
  // payment has been taken, so a pipeline failure is logged for admin
  // follow-up instead of deleting a paid submission.
  const submissionData = submission.submission_data || {};
  const pipelineResult = await runFormEntityPipelines({ supabase, submission, form, baseUrl });
  const pipelineCreatedMemberId = pipelineResult.memberId;
  const pipelineCreatedOrgId = pipelineResult.organizationId;
  const pipelineSucceeded = !pipelineResult.failed && !pipelineResult.partial;

  // Conditional-logic membership action (Task #3489): create the membership
  // history row, accounting invoice, and fire the paid workflow. Runs inside
  // the finalize claim; internally idempotent (payment-ref + (entity, year)
  // guards). Failures are recorded on the submission, never thrown.
  let membershipSucceeded = true;
  if (meta.membership?.quote) {
    try {
      const membershipResult = await finalizeFormMembership({
        supabase,
        submission,
        baseUrl,
        memberId: pipelineCreatedMemberId || submission.created_member_id || null,
        organizationId: pipelineCreatedOrgId || submission.organization_id || null,
      });
      membershipSucceeded = membershipResult?.created === true || membershipResult?.alreadyProcessed === true;
    } catch (err) {
      console.error('[formPaymentFinalize] Membership finalisation failed for', submission.id, err?.message);
      membershipSucceeded = false;
    }
  }

  // The prospective-payment marker limits this to new paid submissions. DD
  // cannot claim until this durable marker follows successful pipelines and
  // membership binding. A later paid-finalization reconciliation retries this
  // idempotent work if either prerequisite was incomplete.
  if (pipelineSucceeded && membershipSucceeded) {
    try {
      await markOneOffDueDiligenceReady(supabase, submission);
      await initializeDueDiligenceSafely(supabase, submission);
    } catch (err) {
      console.error('[formPaymentFinalize] Could not mark one-off DD readiness for', submission.id, err?.message);
    }
  } else {
    console.warn('[formPaymentFinalize] One-off DD remains unready after incomplete financial finalization', submission.id);
  }

  // Configured submission emails — exactly-once via the shared guarded sender.
  try {
    await sendSubmissionEmailsGuarded({
      supabase,
      form,
      formValues: submissionData,
      fields: form.fields || [],
      submissionId: submission.id,
      createdMemberId: pipelineCreatedMemberId,
      createdOrganizationId: pipelineCreatedOrgId,
      baseUrl,
      trigger: 'form_payment_confirm',
      allowUnguarded: false,
    });
  } catch (err) {
    console.error('[formPaymentFinalize] Submission emails failed for', submission.id, err?.message);
  }

  return { finalized: true, ...(resumingUnreadyFinalization ? { retriedUnreadyFinalization: true } : {}) };
}
