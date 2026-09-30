import { isEnhancedAnonymousSettings } from '../../shared/surveyCompletionPolicy.js';

export function surveyAnswerDisplayDate(value, settings) {
  if (!value) return null;
  return isEnhancedAnonymousSettings(settings) ? String(value).slice(0, 10) : value;
}

// Enhanced answers are served only by threshold-aware Survey Reports, not by
// CRM/generic submission lists or general-purpose document exports.
export async function withoutEnhancedSurveyAnswers(db, tenantId, rows) {
  const ids = [...new Set(rows.map(row => row.survey_version_id).filter(Boolean))];
  const protectedVersions = new Set();
  for (let start = 0; start < ids.length; start += 200) {
    const { data, error } = await db.from('survey_version').select('id, survey_settings')
      .eq('tenant_id', tenantId).in('id', ids.slice(start, start + 200));
    if (error || !Array.isArray(data) || data.length !== ids.slice(start, start + 200).length) {
      throw new Error('Survey answer privacy policy could not be verified');
    }
    for (const version of data) {
      if (isEnhancedAnonymousSettings(version.survey_settings)) protectedVersions.add(version.id);
    }
  }
  return rows.filter(row => !protectedVersions.has(row.survey_version_id));
}