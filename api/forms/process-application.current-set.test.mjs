import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('current-set reconciliation is a persisted, signed processing operation', async () => {
  const source = await readFile(new URL('./process-application.js', import.meta.url), 'utf8');
  const persistedLoad = source.indexOf("supabase.from('form_submission').select(");
  const reconcile = source.indexOf('reconcileDepartmentCurrentSet({');
  assert.ok(reconcile > persistedLoad, 'the processor reloads persisted submission data before reconciliation');
  assert.match(source, /submissionId: submission_id/);
  assert.match(source, /values: authoritativeAnswers/);
  assert.match(source, /getMember: async \(\) => currentSetMember/);
  assert.match(source, /currentSetResult \? \{ current_set: currentSetResult \} : \{\}/);
});

test('current-set processing excludes ordinary structured row actions', async () => {
  const source = await readFile(new URL('./process-application.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /hasCurrentSetProcessing\s*\?\s*\{ \.\.\.persistedForm, structured_actions: null \}\s*:\s*persistedForm/,
  );
  assert.match(source, /error instanceof DepartmentCurrentSetError/);
});