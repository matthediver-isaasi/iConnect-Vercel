import { createHash } from 'node:crypto';

// Only call after resolving a tenant-scoped session or a delivered invitation.
// Never pass member IDs, emails or invitation IDs from answer/prefill payloads.
export async function acceptAnonymousSurveyCompletion({
  db, tenantId, formId, versionId, assignmentId = null, memberId = null,
  invitationToken = null, idempotencyKey, submission, answers = [],
}) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw Object.assign(new Error('A survey submission retry key is required'), { code: 'SURVEY_RETRY_KEY_REQUIRED' });
  }
  const { data, error } = await db.rpc('accept_anonymous_survey_completion', {
    p_submission: { ...submission, tenant_id: tenantId, form_id: formId,
      survey_version_id: versionId, survey_assignment_id: assignmentId },
    p_answers: answers,
    p_member_id: memberId,
    p_token_hash: invitationToken ? createHash('sha256').update(invitationToken).digest('hex') : null,
    p_retry_hash: createHash('sha256').update(idempotencyKey).digest('hex'),
  });
  if (error) throw error;
  return data;
}