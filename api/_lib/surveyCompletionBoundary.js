import { isEnhancedAnonymousSurvey } from '../../shared/surveyCompletionPolicy.js';
import { redactIdentityAnswers } from './surveyScoring.js';
import { isRepeatableRowField, repeatableRowChildren } from '../../shared/formRepeatableRows.js';

export function enhancedAnonymousAnswers(fields = [], values = {}) {
  const allowed = {};
  for (const field of fields) {
    if (!field?.id || !Object.hasOwn(values, field.id)) continue;
    const value = values[field.id];
    if (isRepeatableRowField(field) && Array.isArray(value)) {
      allowed[field.id] = value.map(row => enhancedAnonymousAnswers(repeatableRowChildren(field), row || {}));
    } else if (field.type === 'grouped_question' && value && typeof value === 'object' && !Array.isArray(value)) {
      allowed[field.id] = enhancedAnonymousAnswers(field.sub_questions || [], value);
    } else if (field.type === 'score') {
      allowed[field.id] = value && typeof value === 'object'
        ? (value.na === true ? { na: true } : { score: value.score })
        : value;
    } else if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      allowed[field.id] = value;
    } else if (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) {
      allowed[field.id] = value;
    }
    // Composite identity/record answers are incompatible with this mode.
    // Never persist unrecognised object keys from an arbitrary client payload.
  }
  return redactIdentityAnswers(fields, allowed).data;
}

export function enhancedRequiredAnswerErrors(fields = [], values = {}, hidden = new Set()) {
  return fields.filter(field => field.required && !hidden.has(field.id)
    && !['score', 'instructions', 'image', 'grouped_question', 'repeatable_rows'].includes(field.type))
    .filter(field => {
      const value = values[field.id];
      return value == null || typeof value === 'string' && !value.trim()
        || Array.isArray(value) && value.length === 0
        || field.type === 'terms_conditions' && value !== true;
    }).map(field => ({ field_id: field.id, message: `${field.label || 'This question'} is required.` }));
}

// Always consult the published snapshot, not an editable draft response policy.
export async function publishedAnonymousCompletion(db, form, versionId = null) {
  if (form?.form_type !== 'survey') return false;
  let query = db.from('survey_version').select('survey_settings')
    .eq('tenant_id', form.tenant_id).eq('form_id', form.id);
  query = versionId
    ? query.eq('id', versionId)
    : query.eq('version_number', Number(form.survey_settings?.current_version) || 1);
  const { data, error } = await query.maybeSingle();
  if (error || (!data && isEnhancedAnonymousSurvey(form))) throw new Error('Published survey privacy policy is unavailable');
  return isEnhancedAnonymousSurvey({ ...form, survey_settings: data?.survey_settings });
}

export function anonymousCompletionRequestError(body = {}) {
  const forbidden = [
    'prefill_member_id', 'prefill_organization_id', 'organization_id', 'member_id',
    'contract_instance_id', 'brief_id', 'vacancy_id', 'role_id',
    'applicant_continuation_token', 'resume_token', 'submitterCopyEmail',
    'submitterCopyRequested', 'current_set',
  ];
  return forbidden.some(key => body[key] != null && body[key] !== false && body[key] !== '')
    ? 'This anonymous survey cannot save drafts, use identity prefill, send answer copies or perform linked record actions. Open its survey link without those options.'
    : null;
}

export async function submissionUsesAnonymousCompletion(db, form, submissionId) {
  if (form?.form_type !== 'survey') return false;
  if (!submissionId) return publishedAnonymousCompletion(db, form);
  const { data, error } = await db.from('form_submission')
    .select('survey_version_id').eq('id', submissionId)
    .eq('tenant_id', form.tenant_id).eq('form_id', form.id).maybeSingle();
  if (error || !data?.survey_version_id) throw new Error('Survey response privacy policy is unavailable');
  return publishedAnonymousCompletion(db, form, data.survey_version_id);
}