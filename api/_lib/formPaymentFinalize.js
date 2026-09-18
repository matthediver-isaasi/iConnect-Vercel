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
import { randomUUID } from 'node:crypto';

// One-off Stripe confirmations deliberately do not run integration work in the
// public request. The cron owns these short leases instead. A lease is longer
// than its invocation budget, so a timed-out worker cannot be overtaken while
// an in-flight dependency might still be completing; it is still short enough
// for the every-minute recovery sweep to resume a terminated worker promptly.
export const FORM_PAYMENT_COMPLETION_CLAIM_TTL_MS = 2 * 60 * 1000;
export const FORM_PAYMENT_COMPLETION_BUDGET_MS = 40 * 1000;

export function formPaymentCompletionStatus(submission) {
  const completion = submission?.payment_meta?.completion;
  // Historical paid rows predate the explicit completion receipt. Only their
  // actual legacy finalization stamp is compatible terminal evidence. A paid
  // row with neither receipt nor stamp crashed between payment and completion
  // and must keep the truthful retryable finalizing status.
  if (!completion) return submission?.payment_meta?.finalized === true ? 'paid' : 'finalizing';
  if (completion.status === 'done') return 'paid';
  if (completion.status === 'attention') return 'attention';
  return completion.stage === 'accounting' ? 'accounting_pending' : 'finalizing';
}

export async function queueFormPaymentCompletion(supabase, submission) {
  const meta = submission?.payment_meta || {};
  if (meta.completion?.version === 1) return meta;
  const { data, error } = await supabase.rpc('queue_form_payment_completion', {
    p_tenant_id: submission.tenant_id,
    p_submission_id: submission.id,
  });
  if (error) throw error;
  if (!data || typeof data !== 'object') throw new Error('completion receipt was not queued');
  return data;
}

function completionLeaseIsFresh(completion, now = Date.now()) {
  if (completion?.status !== 'processing' || !completion.claimed_at) return false;
  const claimedAt = new Date(completion.claimed_at).getTime();
  return Number.isFinite(claimedAt) && now - claimedAt < FORM_PAYMENT_COMPLETION_CLAIM_TTL_MS;
}

async function recordCompletionOutcome(supabase, submission, completion, status, details = {}) {
  try {
    const { data, error } = await supabase.rpc('finish_form_payment_completion', {
      p_tenant_id: submission.tenant_id,
      p_submission_id: submission.id,
      p_owner_token: completion.owner_token,
      p_status: status,
      p_stage: details.stage || null,
      p_error: details.error ? String(details.error).slice(0, 300) : null,
    });
    if (error) throw error;
    if (data !== true) throw new Error('completion owner claim was lost');
    // Scheduling is deliberately separate from the receipt JSON.  This makes
    // a bounded worker fair: an old retry cannot repeatedly occupy the first
    // page while newer paid submissions wait behind it.
    const { error: retryError } = await supabase.rpc('finish_form_payment_completion_retry', {
      p_tenant_id: submission.tenant_id,
      p_submission_id: submission.id,
      p_status: status,
      p_error: details.error ? String(details.error).slice(0, 300) : null,
    });
    if (retryError) throw retryError;
  } catch (error) {
    // Leave the lease to expire rather than falsely presenting the submission
    // as complete. A later bounded sweep may reclaim the idempotent stages
    // from their own durable checkpoints.
    console.error('[formPaymentFinalize] Completion outcome could not be recorded for', submission.id, error?.message);
  }
}

function logCompletionTiming(submission, stage, startedAt, outcome = 'ok') {
  // Keep diagnostics correlation-only: no answers, customer details, billing
  // address, provider response, or credentials may reach logs.
  console.info('[formPaymentFinalize] completion_timing', {
    submissionId: submission?.id,
    tenantId: submission?.tenant_id,
    stage,
    durationMs: Date.now() - startedAt,
    outcome,
  });
}

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
export async function finalizeFormSubmission({
  supabase,
  submission,
  form,
  baseUrl,
  deadlineAt = null,
}) {
  if (!submission?.id || !form) return { finalized: false };

  const hasBudget = () => !deadlineAt || Date.now() < deadlineAt;
  // Do not start a network-backed stage at the tail of a cron slice. This
  // leaves headroom to persist a retryable outcome before the 60-second
  // serverless ceiling; a later worker may claim the next attempt.
  const canStartStage = () => !deadlineAt || deadlineAt - Date.now() >= 20 * 1000;
  // Claim finalisation: CAS on payment_meta.finalized so the browser
  // confirm and the cron can't both run pipelines.
  const meta = (submission.payment_meta && typeof submission.payment_meta === 'object')
    ? submission.payment_meta : {};
  const completion = meta.completion?.version === 1 ? meta.completion : null;
  let claimedCompletion = null;
  let resumingUnreadyFinalization = false;
  if (completion?.status === 'done') {
    // Older owners could have recorded `done` after a transient readiness
    // write failure. A terminal receipt is the trusted evidence that entity
    // and membership work completed, so restore the missing prerequisite
    // idempotently before asking the independent DD lifecycle to progress.
    let readinessPersisted = true;
    try {
      await markOneOffDueDiligenceReady(supabase, submission);
    } catch (err) {
      readinessPersisted = false;
      console.error('[formPaymentFinalize] Could not restore one-off DD readiness for', submission.id, err?.message);
    }
    const ddOutcome = readinessPersisted
      ? await initializeDueDiligenceSafely(supabase, submission)
      : { ok: false, code: 'ONE_OFF_READY_WRITE_FAILED' };
    return {
      finalized: true,
      alreadyFinalized: true,
      ...(!readinessPersisted || ddOutcome?.ok === false ? { dueDiligencePending: true } : {}),
    };
  }
  if (completion?.status === 'attention') {
    // A previous owner may have crossed a non-idempotent boundary and lost its
    // outcome.  This is terminal for automatic processing; only an explicit
    // administrator resolution may create a new operation.
    return { finalized: false, requiresAttention: true, terminal: true };
  }
  if (completion) {
    if (completionLeaseIsFresh(completion)) {
      return { finalized: false, inProgress: true };
    }
    const claimedAt = new Date().toISOString();
    const nextCompletion = {
      ...completion,
      status: 'processing',
      claimed_at: claimedAt,
      owner_token: randomUUID(),
      attempts: Number(completion.attempts || 0) + 1,
    };
    const { data: claimed, error: claimErr } = await supabase
      .from('form_submission')
      .update({
        payment_meta: {
          ...meta,
          finalized: true,
          finalized_at: meta.finalized_at || claimedAt,
          completion: nextCompletion,
        },
      })
      .eq('id', submission.id)
      .eq('payment_status', 'paid')
      .eq('payment_meta', JSON.stringify(meta))
      .select('*')
      .maybeSingle();
    if (claimErr) {
      console.error('[formPaymentFinalize] Completion claim failed:', claimErr);
      return { finalized: false };
    }
    if (!claimed) {
      const { data: fresh, error: freshErr } = await supabase
        .from('form_submission').select('*').eq('id', submission.id).maybeSingle();
      if (freshErr || !fresh) return { finalized: false };
      return finalizeFormSubmission({ supabase, submission: fresh, form, baseUrl, deadlineAt });
    }
    claimedCompletion = nextCompletion;
  } else if (meta.finalized) {
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
  if (!completion && !resumingUnreadyFinalization) {
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
        deadlineAt,
      });
    }
  }

  // Do not begin another non-transactional stage after the cron's bounded
  // slice expired. The lease/outcome remains durable and a later invocation
  // resumes from each stage's existing idempotency checkpoint.
  if (!canStartStage()) {
    if (claimedCompletion) {
      await recordCompletionOutcome(supabase, submission, claimedCompletion, 'retryable', {
        stage: 'processing',
        error: 'worker budget exhausted before processing started',
      });
    }
    return { finalized: false, retryable: !!claimedCompletion, budgetExhausted: true };
  }

  // Entity pipelines / field mappings — same internal call as the normal
  // submit path, via the shared runner (also used by the reconciliation
  // cron to re-run processing when the membership target entity is still
  // unresolved). Unlike the normal path we never roll the row back: the
  // payment has been taken, so a pipeline failure is logged for admin
  // follow-up instead of deleting a paid submission.
  const submissionData = submission.submission_data || {};
  const pipelineStartedAt = Date.now();
  const pipelineResult = await runFormEntityPipelines({
    supabase,
    submission,
    form,
    baseUrl,
    deadlineAt,
    ...(claimedCompletion ? {
      observeLateSuccess: true,
      completionOperationId: claimedCompletion.owner_token,
      // A durable address-mapping partial is the sole non-structured
      // follow-up permitted to supersede a completed processor operation.
      completionOperationKind: meta.stripe_address_mappings_pending === true
        ? 'followup'
        : 'primary',
    } : {}),
  });
  logCompletionTiming(submission, 'entity_pipelines', pipelineStartedAt, pipelineResult.failed || pipelineResult.partial ? 'incomplete' : 'ok');
  const pipelineCreatedMemberId = pipelineResult.memberId;
  const pipelineCreatedOrgId = pipelineResult.organizationId;
  const pipelineSucceeded = !pipelineResult.failed && !pipelineResult.partial;
  // Entity work establishes the identities and authorization boundary for
  // every remaining side effect. Never continue into membership/accounting,
  // DD, or email with a failed/partial result. In particular an ambiguous
  // operation (including another active owner) may already have caused an
  // effect whose outcome this worker cannot safely infer.
  if (!pipelineSucceeded) {
    const requiresAttention = pipelineResult.ambiguous === true;
    if (claimedCompletion) {
      await recordCompletionOutcome(
        supabase,
        submission,
        claimedCompletion,
        requiresAttention ? 'attention' : 'retryable',
        {
          stage: 'processing',
          error: requiresAttention
            ? 'entity processing has an ambiguous outcome; administrator review is required'
            : (pipelineResult.detail || 'entity processing is incomplete'),
        },
      );
    }
    return {
      finalized: false,
      ...(requiresAttention
        ? { requiresAttention: true }
        : { retryable: true }),
    };
  }

  // Conditional-logic membership action (Task #3489): create the membership
  // history row, accounting invoice, and fire the paid workflow. Runs inside
  // the finalize claim; internally idempotent (payment-ref + (entity, year)
  // guards). Failures are recorded on the submission, never thrown.
  let membershipSucceeded = true;
  let membershipCompletionPending = false;
  let membershipSkippedForBudget = false;
  let membershipFailed = false;
  if (meta.membership?.quote && canStartStage()) {
    const membershipStartedAt = Date.now();
    try {
      const membershipResult = await finalizeFormMembership({
        supabase,
        submission,
        baseUrl,
        memberId: pipelineCreatedMemberId || submission.created_member_id || null,
        organizationId: pipelineCreatedOrgId || submission.organization_id || null,
        deadlineAt,
      });
      membershipSucceeded = membershipResult?.created === true || membershipResult?.alreadyProcessed === true;
      membershipFailed = !membershipSucceeded;
      // A membership row can exist while its provider invoice, Stripe
      // settlement, or paid workflow is still outstanding. Do not report the
      // whole form complete in that state: their own durable checkpoints keep
      // recovery safe and the return receipt shows accounting_pending.
      if (membershipSucceeded && !membershipResult?.alreadyProcessed) {
        const invoiceComplete = membershipResult?.invoiceState === 'done';
        const workflowComplete = membershipResult?.workflowState === 'done';
        const settlementComplete = submission.payment_provider !== 'stripe'
          || membershipResult?.settlementState === 'done';
        membershipCompletionPending = !invoiceComplete || !workflowComplete || !settlementComplete;
      }
    } catch (err) {
      console.error('[formPaymentFinalize] Membership finalisation failed for', submission.id, err?.message);
      membershipSucceeded = false;
      membershipFailed = true;
    }
    logCompletionTiming(submission, 'membership', membershipStartedAt, membershipSucceeded ? 'ok' : 'incomplete');
  } else if (meta.membership?.quote) {
    membershipSucceeded = false;
    membershipSkippedForBudget = true;
  }

  // The prospective-payment marker limits this to new paid submissions. DD
  // cannot claim until this durable marker follows successful pipelines and
  // membership binding. A later paid-finalization reconciliation retries this
  // idempotent work if either prerequisite was incomplete.
  let dueDiligenceReadyPersisted = false;
  let dueDiligenceSkippedForBudget = false;
  let dueDiligenceFailed = false;
  if (pipelineSucceeded && membershipSucceeded && hasBudget()) {
    try {
      await markOneOffDueDiligenceReady(supabase, submission);
      dueDiligenceReadyPersisted = true;
      await initializeDueDiligenceSafely(supabase, submission);
    } catch (err) {
      dueDiligenceFailed = true;
      console.error('[formPaymentFinalize] Could not mark one-off DD readiness for', submission.id, err?.message);
    }
  } else if (pipelineSucceeded && membershipSucceeded && !hasBudget()) {
    dueDiligenceSkippedForBudget = true;
  } else {
    console.warn('[formPaymentFinalize] One-off DD remains unready after incomplete financial finalization', submission.id);
  }

  // Configured submission emails — exactly-once via the shared guarded sender.
  let emailCompleted = true;
  let emailSkippedForBudget = false;
  let emailRequiresAttention = false;
  if (canStartStage()) try {
    const emailStartedAt = Date.now();
    const emailResult = await sendSubmissionEmailsGuarded({
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
      deadlineAt,
    });
    emailCompleted = emailResult?.success === true && emailResult?.durable !== false;
    emailRequiresAttention = emailResult?.requiresAttention === true
      || emailResult?.ambiguousEffect === true
      || emailResult?.state?.status === 'attention';
    logCompletionTiming(
      submission,
      'submission_emails',
      emailStartedAt,
      emailCompleted ? 'ok' : 'incomplete',
    );
  } catch (err) {
    console.error('[formPaymentFinalize] Submission emails failed for', submission.id, err?.message);
    // The guarded sender's durable state remains the source of truth for
    // delivery; completion remains retryable while the durable email outcome
    // is unavailable, but payment status is never reopened.
    emailCompleted = false;
  } else {
    emailCompleted = false;
    emailSkippedForBudget = true;
  }

  const completionSucceeded = pipelineSucceeded
    && membershipSucceeded
    && !membershipCompletionPending
    && emailCompleted
    && !emailRequiresAttention
    && dueDiligenceReadyPersisted;
  const budgetDeferredStages = [
    ...(membershipSkippedForBudget ? ['membership'] : []),
    ...(dueDiligenceSkippedForBudget ? ['due_diligence'] : []),
    ...(emailSkippedForBudget ? ['submission_emails'] : []),
  ];
  // A minimum-budget deferral is not a stage failure. If a real stage
  // failure/attention is also present, retain that signal so reconciliation
  // does not turn a provider or pipeline error into a healthy-looking budget
  // wait.
  const realStageFailure = (meta.membership?.quote && !membershipSucceeded && !membershipSkippedForBudget)
    || membershipCompletionPending
    || (!emailCompleted && !emailSkippedForBudget)
    || dueDiligenceFailed;
  const completionAttention = pipelineResult.ambiguous || emailRequiresAttention;
  const budgetOnlyDeferral = !completionAttention
    && !realStageFailure
    && (budgetDeferredStages.length > 0 || !hasBudget());
  const completionError = completionAttention
    ? (pipelineResult.ambiguous
      ? 'entity processing accepted an operation but its outcome is ambiguous; administrator review is required'
      : 'email delivery outcome is ambiguous; administrator review is required')
    : (realStageFailure
      ? (membershipCompletionPending
        ? 'membership accounting or workflow remains incomplete'
        : (membershipFailed
          ? 'membership finalisation is incomplete'
          : (dueDiligenceFailed
            ? 'one-off due-diligence readiness is incomplete'
            : ((!emailCompleted && !emailSkippedForBudget)
              ? 'submission email delivery is incomplete'
              : 'a required completion stage is incomplete'))))
      : (budgetOnlyDeferral
        ? `worker budget deferred required stage(s): ${budgetDeferredStages.join(', ') || 'completion'}`
        : 'a required completion stage is incomplete'));
  const emailCompletionStatus = (emailRequiresAttention) ? 'attention' : 'retryable';
  if (claimedCompletion) {
    await recordCompletionOutcome(
      supabase,
      submission,
      claimedCompletion,
      completionSucceeded
        ? 'done'
        : (completionAttention ? 'attention' : emailCompletionStatus),
      completionSucceeded
        ? {}
        : {
          stage: membershipCompletionPending ? 'accounting' : 'processing',
          error: completionError,
        },
    );
  }
  return {
    finalized: completionSucceeded || !claimedCompletion,
    ...(claimedCompletion && !completionSucceeded
      ? (completionAttention
        ? { requiresAttention: true }
        : {
          retryable: true,
          ...(budgetOnlyDeferral ? { budgetExhausted: true } : {}),
          ...(budgetDeferredStages.length > 0 ? { budgetDeferredStages } : {}),
        })
      : {}),
    ...(resumingUnreadyFinalization ? { retriedUnreadyFinalization: true } : {}),
  };
}
