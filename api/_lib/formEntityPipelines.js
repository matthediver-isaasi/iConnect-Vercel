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
  };
  const hasEntityPipelines = hasPersistedFormEntityActions(form);
  if (!hasEntityPipelines) return result;
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
      }),
    });
    if (pipelineResponse.ok) {
      result.ran = true;
      try {
        const body = await pipelineResponse.json();
        result.structuredActions = body.structured_actions || null;
        result.relatedRecords = body.related_records || null;
        result.partial = body.structured_actions?.success === false || body.related_records?.success === false;
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
        result.detail = `application processing returned no valid JSON${err?.message ? `: ${err.message}` : ''}`;
        await recordFailure(supabase, submission, processingFailureNote(completionDescription, 'returned no valid JSON'));
      }
    } else {
      const errText = await pipelineResponse.text().catch(() => '');
      console.error('[formEntityPipelines] Pipeline processing failed for paid submission', submission.id, pipelineResponse.status, errText.slice(0, 500));
      result.failed = true;
      result.detail = `application processing failed (HTTP ${pipelineResponse.status})`;
      await recordFailure(supabase, submission, processingFailureNote(completionDescription, `failed (HTTP ${pipelineResponse.status})`));
    }
  } catch (err) {
    console.error('[formEntityPipelines] Pipeline processing error for paid submission', submission.id, err);
    result.failed = true;
    result.detail = `application processing errored${err?.message ? `: ${err.message}` : ''}`;
    await recordFailure(supabase, submission, processingFailureNote(completionDescription, 'errored'));
  }
  return result;
}
