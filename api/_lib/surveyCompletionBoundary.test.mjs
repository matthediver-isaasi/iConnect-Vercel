import assert from 'node:assert/strict';
import test from 'node:test';
import { anonymousCompletionRequestError, enhancedAnonymousAnswers,
  publishedAnonymousCompletion, submissionUsesAnonymousCompletion } from './surveyCompletionBoundary.js';
import { anonymousSurveySubmissionPayload } from '../../client/src/lib/anonymousSurveySubmission.js';

const enhanced = { id: 'form', tenant_id: 'tenant', form_type: 'survey', survey_settings: {
  current_version: 2, response_identity: 'anonymous', anonymous_completion_version: 1,
} };
function dbFixture(settings, error = null) {
  const calls = [];
  return { calls, from(table) {
    calls.push(['from', table]);
    return { select() { return this; }, eq(key, value) { calls.push([key, value]); return this; },
      async maybeSingle() { return { data: table === 'form_submission'
        ? { survey_version_id: 'historic' } : { survey_settings: settings }, error }; } };
  } };
}
test('published privacy uses tenant-scoped immutable version rather than live draft', async () => {
  const db = dbFixture(enhanced.survey_settings);
  assert.equal(await publishedAnonymousCompletion(db, { ...enhanced, survey_settings: { current_version: 2 } }), true);
  assert.ok(db.calls.some(([key, value]) => key === 'tenant_id' && value === 'tenant'));
  assert.ok(db.calls.some(([key, value]) => key === 'version_number' && value === 2));
  const legacy = dbFixture({ response_identity: 'anonymous' });
  assert.equal(await publishedAnonymousCompletion(legacy, enhanced), false);
  await assert.rejects(publishedAnonymousCompletion(dbFixture(null, { code: 'XX' }), enhanced), /unavailable/);
});
test('processing and email replay retain historical response policy', async () => {
  const db = dbFixture(enhanced.survey_settings);
  assert.equal(await submissionUsesAnonymousCompletion(db, enhanced, 'response'), true);
  assert.ok(db.calls.some(([key, value]) => key === 'id' && value === 'historic'));
  const standard = dbFixture(null);
  assert.equal(await submissionUsesAnonymousCompletion(standard, { form_type: 'standard' }, 'response'), false);
  assert.equal(standard.calls.length, 0);
});
test('enhanced redaction excludes unknown fields and unexpected nested object attributes', () => {
  assert.deepEqual(enhancedAnonymousAnswers([
    { id: 'q', type: 'text' }, { id: 'score', type: 'score' }, { id: 'email', type: 'email' },
  ], { q: 'Good', score: { score: 4, member_id: 'secret' }, unknown: 'secret', email: 'secret' }),
  { q: 'Good', score: { score: 4 } });
});
test('native/embed request boundary is enhanced only, and server rejects forged linkage', () => {
  const payload = { form_id: 'form', submission_data: { q: 'Good' },
    member_id: 'forged', prefill_organization_id: 'forged', role_id: 'forged' };
  assert.deepEqual(anonymousSurveySubmissionPayload(enhanced, payload), {
    form_id: 'form', form_name: undefined, submission_data: { q: 'Good' },
  });
  for (const form of [{ form_type: 'standard' }, { form_type: 'survey', survey_settings: { response_identity: 'identified' } },
    { form_type: 'survey', survey_settings: { response_identity: 'anonymous' } }]) {
    assert.equal(anonymousSurveySubmissionPayload(form, payload), payload);
  }
  assert.match(anonymousCompletionRequestError(payload), /identity prefill/);
  assert.equal(anonymousCompletionRequestError({ submission_data: { q: 'Good' }, member_id: null }), null);
});