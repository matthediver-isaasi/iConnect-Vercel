import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { reconcileDeletedSubmission, submissionDeletionRestriction } from './formSubmissionDeletion.js';

test('prunes all list variants, invalidates totals, and fences an outstanding stale list response', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const keys = [
    ['form-submissions'], ['form-submissions', { status: 'new' }],
    ['form-submissions-all'], ['org-form-submissions', 'org'],
    ['member-form-submissions', 'member', 'fixture@example.invalid'],
    ['event-report-linked-submissions', ['form']],
  ];
  const rows = [{ id: 'deleted' }, { id: 'keep' }];
  try {
    for (const key of ['survey-report-summary', 'survey-report-distribution', 'survey-report-comments', 'survey-report-responses', 'survey-report-filters']) {
      client.setQueryData([key, 'survey'], { total: 2 });
    }
    for (const key of keys) client.setQueryData(key, rows);
    client.setQueryData(['form-submission-stats'], { count: 2 });
    client.setQueryData(['unrelated'], rows);
    let release;
    const pending = client.fetchQuery({
      queryKey: keys[0],
      queryFn: () => new Promise(resolve => { release = resolve; }),
    }).catch(() => {});
    await reconcileDeletedSubmission(client, 'deleted');
    release(rows);
    await pending;
    for (const key of keys) {
      assert.deepEqual(client.getQueryData(key), [{ id: 'keep' }]);
      assert.equal(client.getQueryState(key).isInvalidated, true);
    }
    assert.equal(client.getQueryState(['form-submission-stats']).isInvalidated, true);
    assert.deepEqual(client.getQueryData(['unrelated']), rows);
    for (const key of ['survey-report-summary', 'survey-report-distribution', 'survey-report-comments', 'survey-report-responses', 'survey-report-filters']) {
      assert.equal(client.getQueryState([key, 'survey']).isInvalidated, true);
    }
  } finally { client.clear(); }
});

test('survey responses can be deleted while due diligence restrictions remain', () => {
  const submission = { id: 'response', form_id: 'survey', survey_version_id: 'version', survey_assignment_id: 'assignment' };
  const form = { id: 'survey', form_type: 'survey' };
  assert.equal(submissionDeletionRestriction({ submission, form, formReady: true }), null);
  assert.match(submissionDeletionRestriction({ submission, form: { ...form, due_diligence_required: true }, formReady: true }), /Due Diligence/);
});

test('eligibility requires matching, successfully resolved metadata; legacy standard forms remain eligible', () => {
  const submission = { id: 'submission', form_id: 'form' };
  const form = { id: 'form' };
  assert.equal(submissionDeletionRestriction({ submission, form, formReady: true }), null);
  for (const options of [
    { submission, form, formReady: false },
    { submission, form: null, formReady: true },
    { submission, form: { id: 'other' }, formReady: true },
  ]) assert.match(submissionDeletionRestriction(options), /loaded successfully/);
});
