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
  if (meta.finalized) return { finalized: true, alreadyFinalized: true };
  const { data: claimed, error: claimErr } = await supabase
    .from('form_submission')
    .update({ payment_meta: { ...meta, finalized: true, finalized_at: new Date().toISOString() } })
    .eq('id', submission.id)
    .eq('payment_status', 'paid')
    .filter('payment_meta->finalized', 'is', null)
    .select('id')
    .maybeSingle();
  if (claimErr) {
    console.error('[formPaymentFinalize] Finalize claim failed:', claimErr);
    return { finalized: false };
  }
  if (!claimed) return { finalized: true, alreadyFinalized: true };

  const submissionData = submission.submission_data || {};
  const prefillOrgId = meta.prefill_organization_id || null;
  const roleId = meta.role_id || null;
  let pipelineCreatedMemberId = null;
  let pipelineCreatedOrgId = null;

  // Entity pipelines / field mappings — same internal call as the normal
  // submit path. Unlike the normal path we never roll the row back: the
  // payment has been taken, so a pipeline failure is logged for admin
  // follow-up instead of deleting a paid submission.
  const hasEntityPipelines = (form.entity_pipelines?.members?.length > 0)
    || (form.entity_pipelines?.organisations?.length > 0);
  if (hasEntityPipelines && baseUrl) {
    try {
      const pipelineResponse = await fetch(`${baseUrl}/api/forms/process-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form_id: form.id,
          form_values: submissionData,
          fields: form.fields || [],
          field_mappings: form.field_mappings || [],
          application_level: form.application_level || 'member',
          submission_id: submission.id,
          prefill_organization_id: prefillOrgId,
          role_id: roleId,
          entity_pipelines: form.entity_pipelines,
          tenant_id: submission.tenant_id,
        }),
      });
      if (pipelineResponse.ok) {
        try {
          const result = await pipelineResponse.json();
          const resolvedOrgId = result.organization_id || result.created_organization_id;
          const resolvedMemberId = result.created_member_id || result.member_id;
          pipelineCreatedOrgId = resolvedOrgId || null;
          pipelineCreatedMemberId = resolvedMemberId || null;
          const updates = {};
          if (resolvedOrgId && !submission.organization_id) updates.organization_id = resolvedOrgId;
          if (resolvedMemberId) updates.created_member_id = resolvedMemberId;
          if (Object.keys(updates).length > 0) {
            await supabase.from('form_submission').update(updates).eq('id', submission.id);
          }
        } catch { /* no JSON body — fine */ }
      } else {
        const errText = await pipelineResponse.text().catch(() => '');
        console.error('[formPaymentFinalize] Pipeline processing failed for paid submission', submission.id, pipelineResponse.status, errText.slice(0, 500));
        await supabase.from('form_submission').update({
          processing_notes: `Payment succeeded but application processing failed (HTTP ${pipelineResponse.status}). Re-run processing from the submissions list.`,
        }).eq('id', submission.id);
      }
    } catch (err) {
      console.error('[formPaymentFinalize] Pipeline processing error for paid submission', submission.id, err);
      try {
        await supabase.from('form_submission').update({
          processing_notes: 'Payment succeeded but application processing errored. Re-run processing from the submissions list.',
        }).eq('id', submission.id);
      } catch { /* best effort */ }
    }
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

  return { finalized: true };
}
