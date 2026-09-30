import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEnhancedAnonymousSettings, isEnhancedAnonymousSurvey,
  validateAnonymousCompletionConfiguration as validate,
} from './surveyCompletionPolicy.js';
import {
  validateSurveyCompletionUpdate, validateSurveyCompletionPublish,
} from '../api/_lib/surveyCompletionConfiguration.js';

const survey = () => ({
  id: 'form', tenant_id: 'tenant', form_type: 'survey',
  allow_save_continue_later: false,
  survey_settings: { response_identity: 'anonymous', anonymous_completion_version: 1 },
  fields: [{ id: 'quality', type: 'score', label: 'Quality' }],
});

test('only explicit numeric policy on anonymous Survey opts in; legacy and Standard unchanged', () => {
  assert.equal(isEnhancedAnonymousSurvey(survey()), true);
  for (const settings of [{}, { response_identity: 'anonymous' },
    { response_identity: 'anonymous_dedupe' }, { response_identity: 'identified', anonymous_completion_version: 1 },
    { response_identity: 'anonymous', anonymous_completion_version: '1' }]) {
    assert.equal(isEnhancedAnonymousSettings(settings), false);
  }
  assert.equal(isEnhancedAnonymousSurvey({ ...survey(), form_type: 'standard' }), false);
  assert.deepEqual(validate({ form_type: 'standard', is_application_form: true }), []);
  assert.deepEqual(validate({ form_type: 'survey', survey_settings: { response_identity: 'anonymous' }, prefill_source: 'member' }), []);
  assert.deepEqual(validate(survey()), []);
});

test('invalid contract and identity-dependent configurations produce actionable errors', () => {
  for (const patch of [
    { form_type: 'standard' }, { survey_settings: { anonymous_completion_version: 2 } },
    { survey_settings: { anonymous_completion_version: 1, response_identity: 'identified' } },
    { allow_save_continue_later: undefined }, { prefill_source: 'booking' },
    { field_mappings: [{}] }, { entity_pipelines: { members: [{}] } },
    { structured_actions: { actions: [{}] } }, { member_entity_action: 'upsert' },
    { is_application_form: true }, { is_contract: true }, { due_diligence_required: true },
    { prevent_duplicate_email_submission: true }, { allow_submitter_email_copy: true },
    { submission_emails: [{}] }, { communication_category_id: 'category' }, { redirect_url: '/thank-you' },
    { fields: [{ id: 'opaque', type: 'text', prefill_field: 'custom:secret' }] },
    { fields: [{ id: 'rows', type: 'repeatable_rows', repeatable_row: { children: [{ id: 'e', type: 'email' }] } }] },
    { fields: [{ id: 'group', type: 'grouped_question', sub_questions: [{ id: 'e', type: 'email' }] }] },
    { visibility_rules: [{ actions: [{ action_type: 'open_form', form_id: 'other' }] }] },
    { visibility_rules: [{ actions: [{ set_value_source: 'prefill' }] }] },
  ]) assert.ok(validate({ ...survey(), ...patch }).length, JSON.stringify(patch));
});

function dbFixture({ responses = [], version, failure = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      calls.push(table);
      return {
        select() { return this; },
        eq(key, value) { calls.push([key, value]); return this; },
        async limit() { return { data: responses, error: failure ? { message: 'down' } : null }; },
        async maybeSingle() { return { data: version, error: null }; },
      };
    },
  };
}

test('save locks privacy, duplicate policy and survey type once any response exists', async () => {
  for (const patch of [
    { form_type: 'standard', survey_settings: {} },
    { survey_settings: { response_identity: 'identified' } },
    { survey_settings: { response_identity: 'anonymous' } },
    { survey_settings: { ...survey().survey_settings, one_submission_per_respondent: true } },
  ]) {
    const db = dbFixture({ responses: [{ id: 'response' }] });
    assert.ok((await validateSurveyCompletionUpdate(db, survey(), { ...survey(), ...patch })).length);
    assert.ok(db.calls.some(call => Array.isArray(call) && call[0] === 'tenant_id' && call[1] === 'tenant'));
  }
  assert.deepEqual(await validateSurveyCompletionUpdate(dbFixture(), survey(),
    { ...survey(), survey_settings: { response_identity: 'identified' } }), []);
  await assert.rejects(validateSurveyCompletionUpdate(dbFixture({ failure: true }), survey(),
    { ...survey(), survey_settings: {} }), /Could not verify/);
});

test('all configuration changes are validated even when the response policy is unchanged', async () => {
  assert.ok((await validateSurveyCompletionUpdate(dbFixture(), survey(), { ...survey(), is_contract: true })).length);
  assert.deepEqual(await validateSurveyCompletionUpdate(dbFixture(), survey(), { ...survey(), name: 'Renamed' }), []);
});

test('publish checks policy against immutable response snapshot and fails closed', async () => {
  assert.deepEqual(await validateSurveyCompletionPublish(dbFixture(), survey()), []);
  const responses = [{ survey_version_id: 'version' }];
  assert.deepEqual(await validateSurveyCompletionPublish(dbFixture({
    responses, version: { survey_settings: survey().survey_settings },
  }), survey()), []);
  assert.ok((await validateSurveyCompletionPublish(dbFixture({
    responses, version: { survey_settings: { response_identity: 'anonymous' } },
  }), survey())).length);
  await assert.rejects(validateSurveyCompletionPublish(dbFixture({ failure: true }), survey()), /Could not verify/);
});