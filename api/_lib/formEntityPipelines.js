// Shared entity-pipeline runner for PAID form submissions (Task #3489).
//
// Wraps the internal /api/forms/process-application call so both the
// payment finalizer (first run, under the finalize claim) and the
// membership reconciliation cron (re-run when the target entity is still
// unresolved) invoke the pipeline the same way. Re-running is the same
// operation an admin performs from the submissions list ("Re-run
// processing"); process-application receives the submission_id and the
// entity creation matches/updates existing records, so a retry after a
// transient failure resolves the ids rather than duplicating entities.
//
// Never throws. Callers must inspect `failed` / `partial`; `ran` only says that
// the HTTP endpoint was reached successfully and is not a success indicator.
import { buildFormProcessingHeaders } from './formProcessingAuth.js';
import { getInternalApiBaseUrl } from './publicBaseUrl.js';
import { hasPersistedFormEntityActions } from './formEntityActionMode.js';

const GENERATED_FAILURE_NOTE = /^(?:Payment succeeded|Payment setup completed) but application processing (?:was skipped \(no base URL\)|failed \(HTTP \d+\)|errored|returned no valid JSON|was incomplete|could not save resolved entities)\. Re-run processing from the submissions list\.$/;

function processingFailureNote(completionDescription, detail) {
  return `${completionDescription} but application processing ${detail}. Re-run processing from the submissions list.`;
}

function withoutGeneratedFailureNotes(notes) {
  if (typeof notes !== 'string') return notes ?? null;
  const kept = notes.split('\n').filter(line => !GENERATED_FAILURE_NOTE.test(line.trim()));
  return kept.join('\n').trim() || null;
}

async function updateNotesCas(supabase, submission, nextNotes) {
  const previous = submission.processing_notes ?? null;
  if (previous === nextNotes) return true;
  let query = supabase.from('form_submission').update({ processing_notes: nextNotes }).eq('id', submission.id);
  query = previous === null
    ? query.filter('processing_notes', 'is', null)
    : query.eq('processing_notes', previous);
  const { error } = await query;
  if (!error) submission.processing_notes = nextNotes;
  return !error;
}

async function recordFailure(supabase, submission, note) {
  const previous = submission.processing_notes;
  const lines = typeof previous === 'string' ? previous.split('\n') : [];
  const next = lines.some(line => line.trim() === note) ? previous : [...lines.filter(Boolean), note].join('\n');
  try {
    await updateNotesCas(supabase, submission, next);
  } catch { /* best effort */ }
}

async function clearGeneratedFailure(supabase, submission) {
  const next = withoutGeneratedFailureNotes(submission.processing_notes);
  if (next === submission.processing_notes) return;
  try {
    await updateNotesCas(supabase, submission, next);
  } catch { /* best effort; never clobber a concurrently-written note */ }
}

export async function runFormEntityPipelines({
  supabase,
  submission,
  form,
  baseUrl: _legacyBaseUrl,
  completionDescription = 'Payment succeeded',
  // A paid completion owner supplies this opaque UUID.  It is not a retry
  // key: it identifies one attempt which may have reached the processor even
  // if its HTTP response was lost.  A later owner must inspect its durable
  // state rather than replaying that ambiguous attempt.
  completionOperationId = null,
  // Only a persisted structured/related-record pending marker may authorize a
  // `followup`; ordinary completion retries always reuse their known result.
  completionOperationKind = 'primary',
  observeLateSuccess = false,
  deadlineAt = null,
}) {
  const result = {
    ran: false,
    failed: false,
    detail: null,
    memberId: null,
    organizationId: null,
    partial: false,
    structuredActions: null,
    relatedRecords: null,
    stripeAddressMappings: null,
  };
  const hasEntityPipelines = hasPersistedFormEntityActions(form);
  // Removing the form's actions while its last request is running must not
  // bypass the same-operation fence for the remaining payment effects.
  if (!hasEntityPipelines && !(observeLateSuccess
      && submission.payment_meta?.completion?.awaiting_pipeline)) return result;
  // Security boundary: callers also use baseUrl for user-facing links, and
  // some derive it from request headers/custom domains. Internal auth proofs
  // must only ever be sent to the configured deployment itself.
  const processingBaseUrl = getInternalApiBaseUrl(null);
  if (!processingBaseUrl) {
    // Task #3502: never skip silently — a paid submission whose pipelines
    // don't run means the member/org record is never created and membership
    // finalization loops on awaiting_entity forever. Leave a visible trail.
    console.error('[formEntityPipelines] Application processing skipped for paid submission', submission?.id, '- no base URL available');
    result.failed = true;
    result.detail = 'application processing was skipped (no base URL)';
    await recordFailure(supabase, submission, processingFailureNote(completionDescription, 'was skipped (no base URL)'));
    return result;
  }

  const meta = (submission.payment_meta && typeof submission.payment_meta === 'object')
    ? submission.payment_meta : {};
  const verifiedSubmitterMemberId = meta.verified_submitter_member_id || null;
  const verifiedAdminAccess = meta.verified_admin_access === true;
  if (completionOperationId) {
    try {
      const { data: operation, error } = await supabase.rpc(
        observeLateSuccess ? 'observe_or_begin_form_paid_pipeline_operation' : 'begin_form_paid_pipeline_operation', {
        p_tenant_id: submission.tenant_id,
        p_submission_id: submission.id,
        p_operation_id: completionOperationId,
        p_operation_kind: completionOperationKind,
      });
      if (error) throw error;
      if (operation?.status === 'done') {
        // The processor stored entity linkage before it marked this operation
        // done. Reload only these durable checkpoints; never replay it just to
        // recover a response body.
        const { data: current, error: currentError } = operation.checkpoints
          ? { data: operation.checkpoints }
          : await supabase
          .from('form_submission')
          .select('created_member_id, created_organization_id, organization_id, payment_meta')
          .eq('id', submission.id).eq('tenant_id', submission.tenant_id)
          .maybeSingle();
        if (currentError) throw currentError;
        if (!current) throw new Error('durable processor checkpoints are unavailable');
        result.ran = true;
        result.memberId = current?.created_member_id || null;
        result.organizationId = current?.organization_id || current?.created_organization_id || null;
        result.structuredActions = current?.payment_meta?.structured_actions_result || null;
        result.relatedRecords = current?.payment_meta?.related_records_result || null;
        result.stripeAddressMappings = current?.payment_meta?.stripe_address_mappings_result || null;
        result.partial = current?.payment_meta?.structured_actions_pending === true
          || current?.payment_meta?.related_records_pending === true
          || current?.payment_meta?.stripe_address_mappings_pending === true;
        if (result.partial) result.detail = 'application processing has pending or failed actions';
        return result;
      }
      if (operation?.status === 'waiting') {
        result.failed = true;
        result.awaitingOperation = true;
        result.detail = operation.reason;
        return result;
      }
      if (operation?.status !== 'claimed') {
        result.failed = true;
        // A different processor still owns this operation. Its external
        // effects are unknown to this worker, so downstream membership,
        // accounting, DD, and emails must be fenced behind attention rather
        // than treated as an ordinary retryable pipeline failure.
        result.ambiguous = true;
        result.detail = operation?.reason || 'application processing is already owned by another worker';
        return result;
      }
    } catch (err) {
      result.failed = true;
      result.detail = `application processing reservation failed${err?.message ? `: ${err.message}` : ''}`;
      await recordFailure(supabase, submission, processingFailureNote(completionDescription, 'could not reserve a durable operation'));
      return result;
    }
  }

  let abortTimer = null;
  let signal;
  const markAmbiguousOperation = async () => {
    if (!completionOperationId) return;
    result.ambiguous = true;
    try {
      await supabase.rpc('finish_form_paid_pipeline_operation', {
        p_tenant_id: submission.tenant_id,
        p_submission_id: submission.id,
        p_operation_id: completionOperationId,
        p_status: 'attention',
        p_error: 'The processor response was unavailable; do not automatically replay this operation.',
      });
    } catch {
      // The watchdog migration makes an abandoned reservation visible.
    }
  };
  if (deadlineAt) {
    // Abort the *transport*, rather than racing the Promise.  Fetch honours
    // this signal and closes the internal HTTP request. New completion owners
    // observe the exact durable reservation for a bounded time; legacy callers
    // retain attention-required semantics. Neither path replays a lost request.
    // Reserve a few seconds for the caller to persist an owner-fenced outcome
    // after the transport closes.
    const remaining = deadlineAt - Date.now() - 5_000;
    if (remaining <= 0) {
      result.failed = true;
      result.detail = 'application processing was not started before its deadline';
      await markAmbiguousOperation();
      return result;
    }
    const controller = new AbortController();
    abortTimer = setTimeout(() => controller.abort(new Error('application processing deadline exceeded')), remaining);
    signal = controller.signal;
  }
  try {
    const pipelineResponse = await fetch(`${processingBaseUrl}/api/forms/process-application`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildFormProcessingHeaders({
          tenantId: submission.tenant_id,
          formId: form.id,
          submissionId: submission.id,
          verifiedSubmitterMemberId,
          verifiedAdminAccess,
        }),
      },
      body: JSON.stringify({
        form_id: form.id,
        form_values: submission.submission_data || {},
        fields: form.fields || [],
        field_mappings: form.field_mappings || [],
        application_level: form.application_level || 'member',
        submission_id: submission.id,
        prefill_organization_id: meta.prefill_organization_id || null,
        role_id: meta.role_id || null,
        entity_pipelines: form.entity_pipelines,
        tenant_id: submission.tenant_id,
        verified_submitter_member_id: verifiedSubmitterMemberId,
        verified_admin_access: verifiedAdminAccess,
        ...(completionOperationId ? { completion_operation_id: completionOperationId } : {}),
        ...(completionOperationId ? { completion_operation_kind: completionOperationKind } : {}),
      }),
      ...(signal ? { signal } : {}),
    });
    if (pipelineResponse.ok) {
      result.ran = true;
      try {
        const body = await pipelineResponse.json();
        result.structuredActions = body.structured_actions || null;
        result.relatedRecords = body.related_records || null;
        result.stripeAddressMappings = body.stripe_address_mappings || null;
        // Monthly setup must establish the plan before its first paid invoice
        // can authorize profile address writes. Only a successful full
        // processor response may defer that separate mapping obligation.
        // A 409 is still incomplete: it may have returned before other actions.
        const addressAwaitingFirstPayment = submission.payment_provider === 'stripe_monthly_card'
          && submission.payment_status === 'setup_complete'
          && body.success === true
          && body.addressAwaitingFirstPayment === true
          && body.stripe_address_mappings?.pending === true
          && body.stripe_address_mappings?.reason === 'first_payment_not_paid'
          && body.structured_actions?.success !== false
          && body.related_records?.success !== false;
        result.partial = body.structured_actions?.success === false
          || body.related_records?.success === false
          || (body.stripe_address_mappings?.pending === true && !addressAwaitingFirstPayment);
        if (addressAwaitingFirstPayment) result.addressAwaitingFirstPayment = true;
        if (body.success === false && !result.partial) result.failed = true;
        if (result.partial) result.detail = 'application processing has pending or failed actions';
        else if (result.failed) result.detail = 'application processing reported failure';
        const resolvedOrgId = body.organization_id || body.created_organization_id;
        const resolvedMemberId = body.created_member_id || body.member_id;
        result.organizationId = resolvedOrgId || null;
        result.memberId = resolvedMemberId || null;
        const updates = {};
        if (resolvedOrgId && !submission.organization_id) updates.organization_id = resolvedOrgId;
        if (resolvedMemberId) updates.created_member_id = resolvedMemberId;
        if (Object.keys(updates).length > 0) {
          const { error } = await supabase.from('form_submission').update(updates).eq('id', submission.id);
          if (error) {
            result.failed = true;
            result.detail = `resolved entity persistence failed: ${error.message}`;
          }
        }
        if (!result.failed && !result.partial) {
          await clearGeneratedFailure(supabase, submission);
        } else {
          await recordFailure(
            supabase,
            submission,
            processingFailureNote(completionDescription, result.partial ? 'was incomplete' : 'errored'),
          );
        }
      } catch (err) {
        result.failed = true;
        await markAmbiguousOperation();
        result.detail = `application processing returned no valid JSON${err?.message ? `: ${err.message}` : ''}`;
        await recordFailure(supabase, submission, processingFailureNote(completionDescription, 'returned no valid JSON'));
      }
    } else {
      // A persisted structured-action partial is a known, durable processor
      // outcome. It deliberately uses 409 to preserve the existing public
      // contract, but is safe to retry through an explicitly authorized
      // follow-up operation; it is not a lost-response ambiguity.
      let knownPartial = null;
      if (pipelineResponse.status === 409) {
        try {
          const body = await pipelineResponse.json();
          if (body?.retryable === true
              && (
                (body?.code === 'STRUCTURED_ACTIONS_INCOMPLETE'
                  && body?.structured_actions?.success === false)
                || (body?.code === 'STRIPE_ADDRESS_MAPPINGS_INCOMPLETE'
                  && body?.stripe_address_mappings?.pending === true)
              )) {
            knownPartial = body;
          }
        } catch { /* fall through to conservative ambiguous handling */ }
      }
      if (knownPartial) {
        result.ran = true;
        result.partial = true;
        result.detail = knownPartial.code === 'STRIPE_ADDRESS_MAPPINGS_INCOMPLETE'
          ? 'application processing has durable incomplete Stripe address mappings'
          : 'application processing has durable incomplete structured actions';
        result.structuredActions = knownPartial.structured_actions || null;
        result.stripeAddressMappings = knownPartial.stripe_address_mappings || null;
        result.memberId = knownPartial.created_member_id || null;
        result.organizationId = knownPartial.organization_id
          || knownPartial.created_organization_id || null;
        return result;
      }
      const errText = await pipelineResponse.text().catch(() => '');
      console.error('[formEntityPipelines] Pipeline processing failed for paid submission', submission.id, pipelineResponse.status, errText.slice(0, 500));
      result.failed = true;
      await markAmbiguousOperation();
      result.detail = `application processing failed (HTTP ${pipelineResponse.status})`;
      await recordFailure(supabase, submission, processingFailureNote(completionDescription, `failed (HTTP ${pipelineResponse.status})`));
    }
  } catch (err) {
    console.error('[formEntityPipelines] Pipeline processing error for paid submission', submission.id, err);
    result.failed = true;
    if (observeLateSuccess && completionOperationId && signal?.aborted) {
      // Only our local transport deadline is eligible for bounded observation.
      // The reservation and exact identity were saved before dispatch. Never
      // change the remote processor's status or resend this operation.
      result.awaitingOperation = true;
    } else {
      await markAmbiguousOperation();
    }
    result.detail = `application processing errored${err?.message ? `: ${err.message}` : ''}`;
    await recordFailure(supabase, submission, processingFailureNote(completionDescription, 'errored'));
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
  return result;
}
