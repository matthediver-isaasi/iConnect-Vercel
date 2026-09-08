import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('ordinary submissions load persisted visibility context for repeatable validation', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /\.select\('[^']*\bfields, pages, visibility_rules\b[^']*'\)/);
  assert.match(source, /validateRepeatableRowSubmission\(\{[\s\S]*?visibilityOptions: submissionVisibilityOptions,/);
});

test('survey submissions validate repeatable rows against the published visibility snapshot', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  assert.match(source, /const relationshipForm = isSurvey \? \{[\s\S]*?fields: surveyVersion\?\.fields \|\| \[\],[\s\S]*?pages: surveyVersion\?\.pages \|\| \[\],[\s\S]*?visibility_rules: surveyVersion\?\.visibility_rules \|\| \[\]/);
  const validationStart = source.indexOf('await validateRepeatableRowSubmission({');
  const validationEnd = source.indexOf('});', validationStart);
  const validation = source.slice(validationStart, validationEnd);
  assert.match(validation, /form: relationshipForm/);
  assert.match(validation, /hiddenFieldIds: hiddenRelationshipFieldIds/);
});

test('public submissions normalize not-listed organisation targets before UUID-backed use', async () => {
  const source = await readFile(new URL('./form-submission.js', import.meta.url), 'utf8');
  const normalization = source.indexOf(
    'const prefill_organization_id = normalizeFormPrefillOrganizationId(requestedPrefillOrganizationId)',
  );
  const duplicateLookup = source.indexOf("organization_id.eq.${prefill_organization_id}");
  const submissionInsert = source.indexOf('...(prefill_organization_id && { organization_id: prefill_organization_id })');
  const pipelinePayload = source.indexOf('prefill_organization_id: prefill_organization_id || null');
  assert.ok(normalization > -1);
  assert.ok(duplicateLookup > normalization);
  assert.ok(submissionInsert > normalization);
  assert.ok(pipelinePayload > normalization);
});