// P0001 is PostgreSQL's generic RAISE EXCEPTION code, not an invitation status.
// Match only the fixed messages emitted by the invitation boundary; never
// expose or log arbitrary database messages/details (they can contain answers).
const invitationConflicts = new Set([
  'Certificate survey invitation unavailable',
  'Certificate survey invitation scope or publication changed',
  'Certificate survey booking event changed',
  'Certificate survey booking is no longer confirmed for this recipient',
]);

export function isSurveyInvitationConflict(error) {
  return error?.code === 'P0001' && invitationConflicts.has(error.message);
}

export function surveySubmissionDiagnostic(error) {
  let reason = 'database_failure';
  if (isSurveyInvitationConflict(error)) reason = 'invitation_conflict';
  else if (error?.code === 'P0001') {
    if (/^Disallowed form_submission column: /.test(error.message || '')) reason = 'submission_column_contract';
    else if (/^Disallowed survey_answer column: /.test(error.message || '')) reason = 'answer_column_contract';
    else if (error.message === 'survey_answer linkage mismatch') reason = 'answer_linkage';
    else reason = 'unexpected_validation';
  } else if (error?.code === '23505') reason = 'unique_constraint';
  return {
    code: /^[A-Z0-9]{5}$/.test(error?.code || '') ? error.code : 'unknown',
    reason,
  };
}