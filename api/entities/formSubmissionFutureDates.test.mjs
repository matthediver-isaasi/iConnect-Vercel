import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateGenericFormSubmissionFutureDates } from './[entity]/index.js';

test('generic FormSubmission POST validation reports active top-level and repeatable date errors', () => {
  const form = {
    fields: [
      { id: 'start_date', type: 'date', future_only: true },
      {
        id: 'hidden_date',
        type: 'date',
        future_only: true,
        starts_hidden: true,
      },
      {
        id: 'rows',
        type: 'repeatable_rows',
        children: [{ id: 'child_date', type: 'date', future_only: true }],
      },
    ],
  };
  const result = validateGenericFormSubmissionFutureDates({
    form,
    submissionData: {
      start_date: '2020-01-01',
      hidden_date: '2020-01-02',
      rows: [{ _row_id: 'row-1', child_date: '2020-01-03' }],
    },
  });

  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors[0], {
    field_id: 'start_date',
    message: 'Date must be in the future.',
  });
  assert.deepEqual(result.errors[1], {
    field_id: 'rows',
    child_id: 'child_date',
    row: 0,
    message: 'Date must be in the future.',
  });
  assert.equal(result.hiddenFieldIds.has('hidden_date'), true);
});

test('generic FormSubmission validation receives the published snapshot rather than mutable live fields', () => {
  const liveForm = {
    fields: [{ id: 'date', type: 'date', future_only: false }],
  };
  const publishedSnapshot = {
    fields: [{ id: 'date', type: 'date', future_only: true }],
    pages: [],
    visibility_rules: [],
  };
  const values = { date: '2020-01-01' };

  assert.deepEqual(
    validateGenericFormSubmissionFutureDates({
      form: liveForm,
      submissionData: values,
    }).errors,
    [],
  );
  assert.equal(
    validateGenericFormSubmissionFutureDates({
      form: publishedSnapshot,
      submissionData: values,
    }).errors[0].field_id,
    'date',
  );
});

test('generic FormSubmission validation uses authoritative LMIC visibility options', () => {
  const form = {
    fields: [
      { id: 'country', type: 'country' },
      { id: 'date', type: 'date', future_only: true, starts_hidden: true },
    ],
    visibility_rules: [{
      conditions: [{ field_id: 'country', operator: 'is_not_lmic' }],
      actions: [{
        action_type: 'visibility',
        field_states: { date: { visible: true } },
      }],
    }],
  };
  const result = validateGenericFormSubmissionFutureDates({
    form,
    submissionData: { country: 'US', date: '2020-01-01' },
    visibilityOptions: { lmicCodes: ['BD'] },
  });

  assert.equal(result.hiddenFieldIds.has('date'), false);
  assert.equal(result.errors[0].field_id, 'date');
});

test('generic FormSubmission idempotency race winners recheck answers before replay', async () => {
  const source = await readFile(new URL('./[entity]/index.js', import.meta.url), 'utf8');
  const raceStart = source.indexOf(
    "if (tableName === 'form_submission' && formSubmissionIdemKey && sanitizedBody.form_id)",
  );
  const raceBlock = source.slice(raceStart, raceStart + 1800);
  assert.match(raceBlock, /if \(winner\)/);
  assert.match(raceBlock, /sameIdempotencyAnswers\(\s*winner\.submission_data,\s*sanitizedBody\.submission_data/);
});