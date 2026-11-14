import { calculateAssessment } from './scoring.js';

// Caller must resolve a normal tenant member or an external restricted session;
// never accept memberId/session hashes supplied in the browser JSON body.
export async function saveAssessment(database, authority, input) {
  if (!authority?.tenantId || Number(Boolean(authority.memberId)) + Number(Boolean(authority.sessionHash)) !== 1) {
    throw new Error('Verified judging authority required');
  }
  const { data: assignment, error } = await database.from('assessment_assignment')
    .select('id,appointment_id,round_id,criteria_version_id,application_version_id')
    .eq('tenant_id', authority.tenantId).eq('id', input.assignmentId).maybeSingle();
  if (error) throw error;
  if (!assignment) throw new Error('Assignment unavailable');
  const { data: definition, error: criteriaError } = await database.from('assessment_criteria_version')
    .select('definition').eq('tenant_id', authority.tenantId)
    .eq('round_id', assignment.round_id).eq('id', assignment.criteria_version_id).maybeSingle();
  if (criteriaError) throw criteriaError;
  if (!definition) throw new Error('Assigned criteria unavailable');
  if (input.criteriaVersionId !== assignment.criteria_version_id || input.applicationVersionId !== assignment.application_version_id) {
    throw new Error('Review version changed; reload before saving');
  }
  let computed;
  try { computed = calculateAssessment(definition.definition, input.answers, { final: input.submit === true }); }
  catch(error) { error.status=400; throw error; }
  const { data, error: saveError } = await database.rpc('assessment_record_revision', {
    p_tenant: authority.tenantId, p_assignment: assignment.id, p_member: authority.memberId || null,
    p_session_hash: authority.sessionHash || null, p_csrf_hash: authority.csrfHash || null,
    p_expected_revision: input.expectedRevision, p_request_id: input.requestId, p_submit: input.submit === true,
    p_answers: input.answers, p_exact_score: computed.score,
    p_criteria_version: assignment.criteria_version_id, p_application_version: assignment.application_version_id,
  });
  if (saveError) throw saveError;
  return { ...data, score: computed.score, flags: computed.flags, scoringComplete: computed.scoringComplete };
}
