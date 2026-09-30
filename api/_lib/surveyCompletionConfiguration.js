import {
  surveyResponsePolicy,
  validateAnonymousCompletionConfiguration,
} from '../../shared/surveyCompletionPolicy.js';

// Called before all generic form updates, not only updates to survey_settings.
// A new payment/action/prefill configuration must not bypass the privacy gate.
export async function validateSurveyCompletionUpdate(db, existing, next) {
  const errors = validateAnonymousCompletionConfiguration(next);
  if (errors.length) return errors;
  if (existing?.form_type !== 'survey' || surveyResponsePolicy(existing) === surveyResponsePolicy(next)) return [];
  const { data, error } = await db.from('form_submission').select('id')
    .eq('tenant_id', existing.tenant_id).eq('form_id', existing.id).limit(1);
  if (error) throw new Error('Could not verify survey response policy. Please retry before saving.');
  if (data?.length) return ['Response identity, anonymous completion policy, duplicate policy and form type cannot change after a survey receives responses. Create a new survey instead.'];
  return [];
}

export async function validateSurveyCompletionPublish(db, form) {
  const errors = validateAnonymousCompletionConfiguration(form);
  if (errors.length) return errors;
  const { data: responses, error } = await db.from('form_submission').select('survey_version_id')
    .eq('tenant_id', form.tenant_id).eq('form_id', form.id).limit(1);
  if (error) throw new Error('Could not verify the published survey response policy.');
  if (!responses?.length) return [];
  if (!responses[0].survey_version_id) return ['The historical response policy cannot be verified. Create a new survey instead.'];
  const { data: version, error: versionError } = await db.from('survey_version').select('survey_settings')
    .eq('tenant_id', form.tenant_id).eq('form_id', form.id)
    .eq('id', responses[0].survey_version_id).maybeSingle();
  if (versionError || !version) throw new Error('Could not verify the historical survey response policy.');
  return surveyResponsePolicy({ form_type: 'survey', survey_settings: version.survey_settings }) === surveyResponsePolicy(form)
    ? [] : ['The response policy differs from existing responses. Restore the published identity and duplicate policy or create a new survey.'];
}