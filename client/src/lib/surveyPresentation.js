import { isFieldValueFilled } from '@/lib/formFieldPrefill';

/**
 * Task #3330: shared survey presentation helpers for the public form
 * surfaces (FormView, EmbedForm, iEdit form element).
 */

const DISPLAY_ONLY_TYPES = ['instructions', 'image'];

export function isSurveyForm(form) {
  return form?.form_type === 'survey';
}

export function surveyIntroText(form) {
  return isSurveyForm(form) ? (form?.survey_settings?.intro_text || '') : '';
}

export function surveySuccessMessage(form) {
  if (isSurveyForm(form) && form?.survey_settings?.thank_you_message) {
    return form.survey_settings.thank_you_message;
  }
  return form?.success_message;
}

/**
 * Returns the form with survey presentation applied: question-number label
 * prefixes when enabled. Non-survey forms are returned untouched.
 */
export function applySurveyPresentation(form) {
  if (!isSurveyForm(form)) return form;
  const settings = form.survey_settings || {};
  if (!settings.show_question_numbers) return form;
  let n = 0;
  const fields = (form.fields || []).map((field) => {
    if (DISPLAY_ONLY_TYPES.includes(field.type)) return field;
    n += 1;
    return { ...field, label: `${n}. ${field.label || ''}`.trim() };
  });
  return { ...form, fields };
}

/** Progress across visible question fields (for the survey progress bar). */
export function surveyProgress(form, hiddenFieldIds, formValues) {
  const fields = (form?.fields || []).filter(
    (f) => !DISPLAY_ONLY_TYPES.includes(f.type) && !(hiddenFieldIds && hiddenFieldIds.has(f.id))
  );
  const total = fields.length;
  const answered = fields.filter((f) => isFieldValueFilled(f, formValues?.[f.id])).length;
  return { answered, total, pct: total > 0 ? Math.round((answered / total) * 100) : 0 };
}

export function showSurveyProgress(form) {
  return isSurveyForm(form) && form?.survey_settings?.show_progress === true;
}
