import { validateEventSurveyScope, eventSurveyEvidence } from './eventSurveyAudience.js';

// Participation identities only. Survey audiences must always name an exact
// assignment; ordinary event forms retain their existing extraction path.
export async function loadSurveyCompletionEmails(db, { tenantId, form, assignmentId = null, eventId, eventType, received = true }) {
  if (form.form_type !== 'survey') return null;
  const scope = await validateEventSurveyScope(db, tenantId, {
    form_id: form.id, survey_assignment_id: assignmentId,
    event_id: eventId, event_type: eventType, received,
  }, form);
  return eventSurveyEvidence(db, tenantId, scope, { requireComplete: received === false });
}