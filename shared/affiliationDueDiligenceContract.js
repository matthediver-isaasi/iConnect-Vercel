/**
 * Explicit opt-in contract for affiliation-only Due Diligence.
 * Stage names ("approved", "rejected") never confer mutation authority.
 * Ordinary tenant configurations are deliberately returned unchanged.
 */
export function affiliationDueDiligenceContract(config) {
  const policy = config?.affiliation_review;
  if (policy == null || policy.enabled === false) return null;
  if (policy.enabled !== true || policy.version !== 1) {
    throw new Error('Unsupported affiliation-review configuration');
  }
  if (!Array.isArray(config.workflow_stages) || !config.workflow_stages.length) {
    throw new Error('Affiliation review requires configured Due Diligence stages');
  }
  const stages = config.workflow_stages;
  const ids = stages.map(stage => stage?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Due Diligence stage identifiers must be unique');
  }
  const { approved_stage_id: approved, rejected_stage_id: rejected } = policy;
  if (!ids.includes(approved) || !ids.includes(rejected) || approved === rejected) {
    throw new Error('Select separate approval and rejection stages for affiliation review');
  }
  // Dedicated review configurations must not inherit join/application
  // side-effects. Only their explicitly permitted action adapter may run.
  return Object.freeze({
    version: 1,
    approvedStageId: approved,
    rejectedStageId: rejected,
    allowedAction: 'member_affiliation_review',
    renewalBlocked: false,
  });
}

export function affiliationReviewStageDecision({
  config, stageId, tenantId, submission, review,
}) {
  const contract = affiliationDueDiligenceContract(config);
  if (!contract) return { handled: false };
  if (!review || !tenantId || review.tenant_id !== tenantId
    || submission?.tenant_id !== tenantId
    || review.due_diligence_submission_id !== submission.id
    || review.review_form_submission_id !== submission.form_submission_id
    || typeof review.snapshot_id !== 'string' || !review.snapshot_id
    || typeof review.member_id !== 'string' || !review.member_id) {
    throw new Error('A verified affiliation-review case is required');
  }
  if (!config.workflow_stages.some(stage => stage.id === stageId)) {
    throw new Error('Unknown affiliation-review stage');
  }
  const outcome = stageId === contract.approvedStageId ? 'approve'
    : stageId === contract.rejectedStageId ? 'reject' : 'review';
  return {
    handled: true,
    outcome,
    runLegacyActions: false,
    blocksRenewal: false,
    requiresAtomicApplication: outcome === 'approve',
    requiresResolvedRecords: outcome === 'approve',
  };
}
