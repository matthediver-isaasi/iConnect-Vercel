// Task #3529 — shared decision logic for the workflow confirmation modal's
// revert-on-fail gating.
//
// Revert is a single-field mutation on the shared triggering field. When a
// field change triggers multiple confirmation-required workflows, reverting
// for one unmet workflow clobbers the change for the whole batch — including
// a change the user explicitly kept by skipping or confirming an earlier
// workflow. So the no-revert "Dismiss (keep change)" option unlocks as soon
// as ANY workflow in the batch has been resolved (skipped OR confirmed),
// not only when one was confirmed.

// True when at least one workflow in the batch has been resolved
// (action === 'skipped' or 'confirmed'). Unlocks the no-revert dismiss path.
export function hasResolvedWorkflows(processedWorkflows) {
  return Array.isArray(processedWorkflows) && processedWorkflows.length > 0;
}

// True when a workflow is an unmet revert-on-fail workflow that would POST a
// revert of the shared triggering field if skipped normally.
export function isRevertWorkflow(w) {
  return !!(w && w.conditions_met === false && w.revert_on_fail && w.revert_field_id);
}

// Payload for the bulk skip/dismiss path. When any workflow in the batch was
// already resolved, unmet revert-on-fail workflows are dismissed WITHOUT
// reverting (revert_on_fail stripped) so the shared field keeps the user's
// change; otherwise workflows pass through unchanged (revert is primary).
export function buildSkipAllPayload(unprocessedWorkflows, anyResolved) {
  if (!anyResolved) return unprocessedWorkflows;
  return unprocessedWorkflows.map(w =>
    (w.conditions_met === false && w.revert_on_fail) ? { ...w, revert_on_fail: false } : w
  );
}
