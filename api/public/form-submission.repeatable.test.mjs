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
  const validationStart = source.indexOf('await validateRepeatableRowSubmission({');
  const validationEnd = source.indexOf('});', validationStart);
  const validation = source.slice(validationStart, validationEnd);
  assert.match(validation, /fields: surveyVersion\?\.fields \|\| \[\]/);
  assert.match(validation, /pages: surveyVersion\?\.pages \|\| \[\]/);
  assert.match(validation, /visibility_rules: surveyVersion\?\.visibility_rules \|\| \[\]/);
});