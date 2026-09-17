import assert from 'node:assert/strict';
import test from 'node:test';
import {
  repeatableDateError,
  repeatableDateHelp,
  repeatableDateLimits,
  repeatableDateSettings,
} from './formRepeatableDates.js';
import { ensureFutureDateRowIds, validateFutureDateFields } from './formFutureDates.js';

const now = new Date('2024-02-29T23:59:59.999Z');

test('repeatable date settings default to unrestricted day precision', () => {
  assert.deepEqual(repeatableDateSettings({ type: 'date' }), {
    precision: 'day',
    restriction: 'any',
    error: null,
  });
  assert.deepEqual(repeatableDateSettings({ type: 'date', future_only: true }), {
    precision: 'day',
    restriction: 'future',
    error: null,
  });
  assert.deepEqual(repeatableDateSettings({ type: 'date', past_only: true }), {
    precision: 'day',
    restriction: 'past',
    error: null,
  });
});

test('explicit settings reject invalid values and contradictions', () => {
  assert.match(repeatableDateSettings({ date_precision: 'decade' }).error, /date_precision/);
  assert.match(repeatableDateSettings({ date_restriction: 'soon' }).error, /date_restriction/);
  assert.match(
    repeatableDateSettings({ date_restriction: 'past', future_only: true }).error,
    /contradicts future_only/,
  );
  assert.match(
    repeatableDateSettings({ future_only: true, past_only: true }).error,
    /cannot both/,
  );
  assert.match(
    repeatableDateSettings({ date_restriction: undefined }).error,
    /date_restriction/,
  );
});

test('strictly validates day, month, and year calendar strings', () => {
  assert.equal(repeatableDateError({ type: 'date' }, '2024-02-29', { now }), null);
  assert.match(repeatableDateError({ type: 'date' }, '2023-02-29', { now }), /YYYY-MM-DD/);
  assert.match(repeatableDateError({ type: 'date' }, '0000-01-01', { now }), /YYYY-MM-DD/);
  assert.equal(repeatableDateError({ type: 'date', date_precision: 'month' }, '2024-02', { now }), null);
  assert.match(repeatableDateError({ type: 'date', date_precision: 'month' }, '2024-13', { now }), /YYYY-MM/);
  assert.equal(repeatableDateError({ type: 'date', date_precision: 'year' }, '0001', { now }), null);
  assert.match(repeatableDateError({ type: 'date', date_precision: 'year' }, '10000', { now }), /YYYY/);
});

test('future and past restrictions use UTC precision boundaries', () => {
  const futureDay = { type: 'date', date_restriction: 'future' };
  const pastMonth = { type: 'date', date_precision: 'month', date_restriction: 'past' };
  const futureYear = { type: 'date', date_precision: 'year', date_restriction: 'future' };
  assert.equal(repeatableDateError(futureDay, '2024-02-29', { now }), 'Date must be in the future.');
  assert.equal(repeatableDateError(futureDay, '2024-03-01', { now }), null);
  assert.equal(repeatableDateError(pastMonth, '2024-02', { now }), 'Date must be in the past.');
  assert.equal(repeatableDateError(pastMonth, '2024-01', { now }), null);
  assert.equal(repeatableDateError(futureYear, '2024', { now }), 'Date must be in the future.');
  assert.equal(repeatableDateError(futureYear, '2025', { now }), null);
});

test('limits are strict and preserve leap-year/month boundaries', () => {
  assert.deepEqual(
    repeatableDateLimits({ type: 'date', date_restriction: 'future' }, { now }),
    { min: '2024-03-01', max: null },
  );
  assert.deepEqual(
    repeatableDateLimits({ type: 'date', date_precision: 'month', date_restriction: 'past' }, { now }),
    { min: null, max: '2024-01' },
  );
  assert.deepEqual(
    repeatableDateLimits({ type: 'date', date_precision: 'year', date_restriction: 'future' }, { now }),
    { min: '2025', max: null },
  );
  assert.deepEqual(
    repeatableDateLimits({ type: 'date', date_restriction: 'any' }, { now }),
    { min: null, max: null },
  );
});

test('help text reflects precision and restriction', () => {
  assert.equal(
    repeatableDateHelp({ type: 'date', date_precision: 'month', date_restriction: 'future' }),
    'Choose a month in the future. The current month is excluded. Dates are compared in UTC.',
  );
  assert.equal(
    repeatableDateHelp({ type: 'date', date_precision: 'year', date_restriction: 'past' }),
    'Choose a year in the past. The current year is excluded. Dates are compared in UTC.',
  );
});

for (const precision of ['day', 'month', 'year']) {
  for (const restriction of ['any', 'past', 'future']) {
    test(`${precision}/${restriction} checks current UTC period and both neighbours`, () => {
      const field = { type: 'date', date_precision: precision, date_restriction: restriction };
      const values = {
        day: ['2024-02-28', '2024-02-29', '2024-03-01'],
        month: ['2024-01', '2024-02', '2024-03'],
        year: ['2023', '2024', '2025'],
      }[precision];
      values.forEach((value, index) => {
        assert.equal(!repeatableDateError(field, value, { now }),
          restriction === 'any' || (restriction === 'past' ? index === 0 : index === 2));
      });
      for (const value of [[], {}, 2024, ' 2024', '2024 ', '2024-00', '2024-2', '-02', 'abcd']) {
        assert.ok(repeatableDateError(field, value, { now }), JSON.stringify(value));
      }
      for (const value of ['', null, undefined]) assert.equal(repeatableDateError(field, value, { now }), null);
    });
  }
}

test('day/month/year UTC transitions roll limits and exclude newly current periods', () => {
  for (const [precision, value, instant, next] of [
    ['day', '2024-03-01', '2024-03-01T00:00:00Z', '2024-03-02'],
    ['month', '2024-03', '2024-03-01T00:00:00Z', '2024-04'],
    ['year', '2025', '2025-01-01T00:00:00Z', '2026'],
  ]) {
    const field = { type: 'date', date_precision: precision, date_restriction: 'future' };
    const boundary = new Date(instant);
    assert.equal(repeatableDateError(field, value, { now: new Date(+boundary - 1) }), null);
    assert.ok(repeatableDateError(field, value, { now: boundary }));
    assert.equal(repeatableDateLimits(field, { now: boundary }).min, next);
  }
  assert.equal(repeatableDateLimits({ date_precision: 'month', date_restriction: 'past' }, {
    now: new Date('2025-01-01T00:00:00Z'),
  }).max, '2024-12');
});

test('new precision applies only to edited history, with one-to-one stable and legacy row matching', () => {
  const field = { id: 'rows', type: 'repeatable_rows', children: [
    { id: 'date', type: 'date', date_precision: 'month', date_restriction: 'past' },
    { id: 'note', type: 'text' },
  ] };
  const previousValues = { rows: [{ date: '2020-02-29', note: 'a' }, { date: '2021-01', note: 'b' }] };
  const rows = ensureFutureDateRowIds(previousValues.rows, field);
  const edited = [{ ...rows[1] }, { ...rows[0], note: 'changed' }];
  assert.deepEqual(validateFutureDateFields([field], { rows: edited }, { now, previousValues }), []);
  edited[1].date = '2020-02-28';
  assert.equal(validateFutureDateFields([field], { rows: edited }, { now, previousValues })[0].row, 1);
  assert.deepEqual(validateFutureDateFields([field], { rows: edited }, {
    now, previousValues, hiddenFieldIds: new Set(['rows']),
  }), []);
  const replacement = { date: '2020-02-29', note: 'new' };
  assert.equal(validateFutureDateFields([field], { rows: [replacement] }, { now, previousValues }).length, 1);
});
