import {
  affiliationDueDiligenceContract,
  affiliationReviewStageDecision,
} from '../../shared/affiliationDueDiligenceContract.js';

/**
 * Dedicated affiliation reviews are an exclusive action lane. Never fall back
 * to join actions when review lookup or execution fails.
 * The decision RPC must own the review lock, actor/stage verification, resolved
 * target validation, original-snapshot check, and atomic affiliation application.
 */
export async function executeAffiliationReviewStage({
  db, config, stageId, submission, tenantId, actor, occurrenceId,
}) {
  let contract;
  try {
    contract = affiliationDueDiligenceContract(config);
    if (!contract) return null; // No additional queries for existing workflows.
    const { data: review, error } = await db.from('form_member_affiliation_review')
      .select('id,tenant_id,due_diligence_submission_id,review_form_submission_id,snapshot_id,member_id,status')
      .eq('tenant_id', tenantId)
      .eq('due_diligence_submission_id', submission.id)
      .maybeSingle();
    if (error) throw new Error('Affiliation review could not be loaded. No affiliation changes were made.');
    const decision = affiliationReviewStageDecision({
      config, stageId, tenantId, submission, review,
    });
    if (decision.outcome === 'review') {
      return { stage_actions_results: [{
        action: 'member_affiliation_review', status: 'skipped',
        reason: 'awaiting_affiliation_decision',
      }] };
    }
    if (!actor || !occurrenceId) throw new Error('A verified review action and actor are required.');
    const { data, error: actionError } = await db.rpc('decide_form_member_affiliation_review', {
      p_tenant_id: tenantId,
      p_review_id: review.id,
      p_due_diligence_submission_id: submission.id,
      p_stage_id: stageId,
      p_occurrence_id: occurrenceId,
      p_actor: actor,
      p_decision: decision.outcome,
    });
    // RPC acknowledgement alone is not proof that membership links changed.
    const expected = decision.outcome === 'approve'
      ? ['applied', 'already_applied'] : ['rejected', 'already_rejected'];
    if (actionError || !expected.includes(data?.status)) {
      throw new Error('Affiliation review needs attention. Its approval or rejection has not been confirmed; no join or payment actions were run.');
    }
    return { stage_actions_results: [{
      action: 'member_affiliation_review', status: 'success', outcome: data.status,
      review_id: review.id,
    }] };
  } catch (error) {
    // An opted-in configuration must fail closed, including malformed policy.
    return { stage_actions_results: [{
      action: 'member_affiliation_review', status: 'error',
      error: error.message || 'Affiliation review needs attention.',
    }] };
  }
}
