import { isEnhancedAnonymousSettings } from '../../shared/surveyCompletionPolicy.js';

// This service returns participation identities only, never answers or response IDs.
export async function loadSurveyCompletionEmails(db, { tenantId, form, assignmentId = null }) {
  if (form.form_type !== 'survey') return null;
  const { data: version, error } = await db.from('survey_version')
    .select('survey_settings').eq('tenant_id', tenantId).eq('form_id', form.id)
    .eq('version_number', Number(form.survey_settings?.current_version) || 1).maybeSingle();
  if (error || !version) throw new Error('Survey response policy could not be verified for campaign targeting');
  if (!isEnhancedAnonymousSettings(version.survey_settings)) return null;

  // A form-wide legacy segment is ambiguous once event assignments exist.
  // Require an explicit assignment instead of crediting another event's completion.
  const { data: assignments, error: assignmentError } = await db.from('event_survey_assignment')
    .select('id, event_id, complex_event_id').eq('tenant_id', tenantId).eq('form_id', form.id)
    .limit(2);
  if (assignmentError) throw new Error('Survey assignment scope could not be verified');
  if (assignmentId) {
    const { data: assignment, error: scopeError } = await db.from('event_survey_assignment')
      .select('id, event_id, complex_event_id').eq('tenant_id', tenantId)
      .eq('form_id', form.id).eq('id', assignmentId).maybeSingle();
    if (scopeError || !assignment
      || (assignment.event_id || assignment.complex_event_id) !== form.related_event_id) {
      throw new Error('Select a survey assignment belonging to this form and event');
    }
  } else if (assignments?.length) {
    throw new Error('Select a survey assignment for anonymous completion targeting');
  }

  const emails = new Set();
  const memberIds = new Set();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    let query = db.from('survey_completion').select('id, member_id, recipient_email')
      .eq('tenant_id', tenantId).eq('form_id', form.id).order('id', { ascending: true });
    query = assignmentId ? query.eq('assignment_id', assignmentId) : query.is('assignment_id', null);
    const { data, error: readError } = await query.range(offset, offset + pageSize - 1);
    if (readError || !Array.isArray(data)) throw new Error('Survey completion evidence is unavailable; campaign targeting stopped');
    for (const row of data) {
      if (row.member_id) memberIds.add(row.member_id);
      if (row.recipient_email) emails.add(row.recipient_email.trim().toLowerCase());
    }
    if (data.length < pageSize) break;
  }
  const ids = [...memberIds];
  for (let start = 0; start < ids.length; start += 200) {
    const { data, error: memberError } = await db.from('member').select('id, email')
      .eq('tenant_id', tenantId).in('id', ids.slice(start, start + 200));
    if (memberError || !Array.isArray(data)) throw new Error('Survey completion member identities are unavailable');
    for (const member of data) {
      if (member.email) emails.add(member.email.trim().toLowerCase());
    }
  }
  return emails;
}