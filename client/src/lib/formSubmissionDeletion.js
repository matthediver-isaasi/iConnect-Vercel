const submissionListKeys = new Set([
  'form-submissions',
  'form-submissions-all',
  'org-form-submissions',
  'member-form-submissions',
  'event-report-linked-submissions',
]);

// These caches all contain arrays of submission records. Cancel outstanding
// reads before pruning so a response started before deletion cannot restore it.
export async function reconcileDeletedSubmission(queryClient, submissionId) {
  const lists = { predicate: query => submissionListKeys.has(query.queryKey[0]) };
  await queryClient.cancelQueries(lists);
  queryClient.setQueriesData(lists, rows => Array.isArray(rows)
    ? rows.filter(row => row.id !== submissionId)
    : rows);
  await queryClient.invalidateQueries({ ...lists, refetchType: 'none' });
  await queryClient.invalidateQueries({ queryKey: ['form-submission-stats'], refetchType: 'none' });
}

export function submissionDeletionRestriction({ submission, form, formReady }) {
  if (!submission?.id || !formReady || !form?.id || form.id !== submission.form_id) {
    return 'Deletion is unavailable until the form details have loaded successfully.';
  }
  if (form.due_diligence_required === true) {
    return 'Due Diligence submissions must be managed through the Due Diligence Dashboard.';
  }
  if (form.form_type === 'survey' || submission.survey_version_id || submission.survey_assignment_id) {
    return 'Survey responses are immutable and cannot be deleted.';
  }
  return null;
}
