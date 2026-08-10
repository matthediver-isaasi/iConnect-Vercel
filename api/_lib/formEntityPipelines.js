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
// Never throws; a failure is logged on the submission's processing_notes
// for admin follow-up (the payment has been taken — the row must never be
// rolled back).

export async function runFormEntityPipelines({ supabase, submission, form, baseUrl }) {
  const result = { ran: false, memberId: null, organizationId: null };
  const hasEntityPipelines = (form?.entity_pipelines?.members?.length > 0)
    || (form?.entity_pipelines?.organisations?.length > 0);
  if (!hasEntityPipelines) return result;
  if (!baseUrl) {
    // Task #3502: never skip silently — a paid submission whose pipelines
    // don't run means the member/org record is never created and membership
    // finalization loops on awaiting_entity forever. Leave a visible trail.
    console.error('[formEntityPipelines] Application processing skipped for paid submission', submission?.id, '- no base URL available');
    try {
      await supabase.from('form_submission').update({
        processing_notes: 'Payment succeeded but application processing was skipped (no base URL). Re-run processing from the submissions list.',
      }).eq('id', submission.id);
    } catch { /* best effort */ }
    return result;
  }

  const meta = (submission.payment_meta && typeof submission.payment_meta === 'object')
    ? submission.payment_meta : {};
  try {
    const pipelineResponse = await fetch(`${baseUrl}/api/forms/process-application`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      }),
    });
    if (pipelineResponse.ok) {
      result.ran = true;
      try {
        const body = await pipelineResponse.json();
        const resolvedOrgId = body.organization_id || body.created_organization_id;
        const resolvedMemberId = body.created_member_id || body.member_id;
        result.organizationId = resolvedOrgId || null;
        result.memberId = resolvedMemberId || null;
        const updates = {};
        if (resolvedOrgId && !submission.organization_id) updates.organization_id = resolvedOrgId;
        if (resolvedMemberId) updates.created_member_id = resolvedMemberId;
        if (Object.keys(updates).length > 0) {
          await supabase.from('form_submission').update(updates).eq('id', submission.id);
        }
      } catch { /* no JSON body — fine */ }
    } else {
      const errText = await pipelineResponse.text().catch(() => '');
      console.error('[formEntityPipelines] Pipeline processing failed for paid submission', submission.id, pipelineResponse.status, errText.slice(0, 500));
      await supabase.from('form_submission').update({
        processing_notes: `Payment succeeded but application processing failed (HTTP ${pipelineResponse.status}). Re-run processing from the submissions list.`,
      }).eq('id', submission.id);
    }
  } catch (err) {
    console.error('[formEntityPipelines] Pipeline processing error for paid submission', submission.id, err);
    try {
      await supabase.from('form_submission').update({
        processing_notes: 'Payment succeeded but application processing errored. Re-run processing from the submissions list.',
      }).eq('id', submission.id);
    } catch { /* best effort */ }
  }
  return result;
}
