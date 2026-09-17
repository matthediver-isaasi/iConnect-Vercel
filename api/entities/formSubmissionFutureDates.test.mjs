import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateGenericFormSubmissionFutureDates } from './[entity]/index.js';
import { validateFutureDateFields } from '../../shared/formFutureDates.js';

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

test('generic FormSubmission validation preserves repeatable date precision and restrictions', () => {
  const form = {
    fields: [{
      id: 'rows',
      type: 'repeatable_rows',
      children: [
        { id: 'month_future', type: 'date', date_precision: 'month', date_restriction: 'future' },
        { id: 'year_past', type: 'date', date_precision: 'year', date_restriction: 'past' },
        { id: 'month_any', type: 'date', date_precision: 'month', date_restriction: 'any' },
      ],
    }],
  };
  const result = validateGenericFormSubmissionFutureDates({
    form,
    submissionData: {
      rows: [{
        _row_id: 'row-1',
        month_future: '2020-01',
        year_past: '2999',
        month_any: '2020-13',
      }],
    },
  });

  assert.deepEqual(result.errors.map(error => ({
    child_id: error.child_id,
    message: error.message,
  })), [
    { child_id: 'month_future', message: 'Date must be in the future.' },
    { child_id: 'year_past', message: 'Year must be the current year or earlier (UTC).' },
    { child_id: 'month_any', message: 'Enter a valid month in YYYY-MM format.' },
  ]);
});

test('generic FormSubmission validation accepts current UTC past-only periods and rejects later periods for canonical and legacy settings', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2024-02-29T23:59:59.999Z'),
  });
  const cases = [
    {
      precision: 'day',
      current: '2024-02-29',
      later: '2024-03-01',
      message: 'Date must be today or earlier (UTC).',
    },
    {
      precision: 'month',
      current: '2024-02',
      later: '2024-03',
      message: 'Month must be the current month or earlier (UTC).',
    },
    {
      precision: 'year',
      current: '2024',
      later: '2025',
      message: 'Year must be the current year or earlier (UTC).',
    },
  ];

  for (const legacy of [false, true]) {
    for (const { precision, current, later, message } of cases) {
      const child = {
        id: 'answer',
        type: 'date',
        date_precision: precision,
        ...(legacy ? { past_only: true } : { date_restriction: 'past' }),
      };
      const form = {
        fields: [{
          id: 'rows',
          type: 'repeatable_rows',
          children: [child],
        }],
      };
      const accepted = validateGenericFormSubmissionFutureDates({
        form,
        submissionData: { rows: [{ _row_id: 'row-current', answer: current }] },
      });
      assert.deepEqual(accepted.errors, [], `${legacy ? 'legacy/' : ''}${precision} current`);

      const rejected = validateGenericFormSubmissionFutureDates({
        form,
        submissionData: { rows: [{ _row_id: 'row-later', answer: later }] },
      });
      assert.deepEqual(rejected.errors, [{
        field_id: 'rows',
        child_id: 'answer',
        row: 0,
        message,
      }], `${legacy ? 'legacy/' : ''}${precision} later`);
    }
  }
});

test('historical repeatable past-only answers stay exempt while an amended row is checked at the frozen clock', (t) => {
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2024-02-29T23:59:59.999Z'),
  });
  const fields = [{
    id: 'rows',
    type: 'repeatable_rows',
    children: [{
      id: 'answer',
      type: 'date',
      date_precision: 'day',
      date_restriction: 'past',
    }],
  }];
  const previousValues = {
    rows: [{ answer: '2025-01-01' }],
  };
  const unchanged = validateFutureDateFields(fields, {
    rows: [{ _row_id: 'legacy-row', answer: '2025-01-01' }],
  }, { previousValues });
  assert.deepEqual(unchanged, []);

  const amended = validateFutureDateFields(fields, {
    rows: [{ _row_id: 'legacy-row', answer: '2024-03-01' }],
  }, { previousValues });
  assert.deepEqual(amended, [{
    field_id: 'rows',
    child_id: 'answer',
    row: 0,
    message: 'Date must be today or earlier (UTC).',
  }]);
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