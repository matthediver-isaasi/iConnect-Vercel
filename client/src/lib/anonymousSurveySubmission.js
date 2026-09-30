import { isEnhancedAnonymousSurvey } from '../../../shared/surveyCompletionPolicy.js';

// Identity authority is the session or the verified invitation, never a URL
// prefill ID, collected email, CRM context, or browser-side side effect.
export function anonymousSurveySubmissionPayload(form, payload) {
  if (!isEnhancedAnonymousSurvey(form)) return payload;
  return {
    form_id: form.id,
    form_name: form.name,
    submission_data: payload.submission_data,
  };
}