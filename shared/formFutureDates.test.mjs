import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ensureFutureDateRowIds,
  futureDateError,
  tomorrowUtcDate,
  validateFutureDateFields,
} from './formFutureDates.js';

const now = new Date('2026-03-10T23:59:59.999Z');
const field = { id: 'start', type: 'date', future_only: true };

test('tomorrowUtcDate uses UTC calendar boundaries', () => {
  assert.equal(tomorrowUtcDate(now), '2026-03-11');
  assert.equal(tomorrowUtcDate(new Date('2026-12-31T23:00:00-08:00')), '2027-01-02');
});

test('futureDateError only applies to native date fields explicitly marked future-only', () => {
  assert.equal(futureDateError(field, '2026-03-11', { now }), null);
  assert.equal(futureDateError({ ...field, future_only: false }, '2026-03-01', { now }), null);
  assert.equal(futureDateError({ ...field, type: 'text' }, '2026-03-01', { now }), null);
  assert.equal(futureDateError(field, '', { now }), null);
  assert.equal(futureDateError(field, null, { now }), null);
});

test('futureDateError rejects malformed, today, and past dates', () => {
  assert.match(futureDateError(field, '2026-02-30', { now }), /YYYY-MM-DD/);
  assert.match(futureDateError(field, '2026-03-10', { now }), /future/i);
  assert.match(futureDateError(field, '2026-03-09', { now }), /future/i);
  assert.equal(futureDateError(field, '2026-03-11', { now }), null);
});

test('validateFutureDateFields reports top-level fields and skips hidden fields', () => {
  const fields = [
    field,
    { id: 'hidden', type: 'date', future_only: true },
    { id: 'ordinary', type: 'date' },
  ];
  assert.deepEqual(
    validateFutureDateFields(fields, {
      start: '2026-03-10',
      hidden: '2026-03-09',
      ordinary: '2026-03-09',
    }, { now, hiddenFieldIds: new Set(['hidden']) }),
    [{ field_id: 'start', message: 'Date must be in the future.' }],
  );
});

test('repeatable children include stable container, child, and row metadata', () => {
  const fields = [{
    id: 'attendees',
    type: 'repeatable_rows',
    children: [
      { id: 'arrival', type: 'date', future_only: true },
      { id: 'name', type: 'text' },
    ],
  }];
  assert.deepEqual(
    validateFutureDateFields(fields, {
      attendees: [
        { _row_id: 'second', arrival: '2026-03-11' },
        { _row_id: 'first', arrival: '2026-03-10' },
      ],
    }, { now }),
    [{
      field_id: 'attendees',
      child_id: 'arrival',
      row: 1,
      message: 'Date must be in the future.',
    }],
  );
});

test('future-date row IDs are deterministic for legacy rows and preserve new IDs', () => {
  const repeatableField = {
    id: 'people',
    type: 'repeatable_rows',
    children: [
      { id: 'date', type: 'date', future_only: true },
      { id: 'name', type: 'text' },
    ],
  };
  const legacyRows = [
    { date: '2026-03-09', name: 'A' },
    { date: '2026-03-12', name: 'B' },
  ];
  const first = ensureFutureDateRowIds(legacyRows, repeatableField);
  const reordered = ensureFutureDateRowIds([...legacyRows].reverse(), repeatableField);
  assert.equal(first[0]._row_id, reordered[1]._row_id);
  assert.equal(first[1]._row_id, reordered[0]._row_id);
  assert.deepEqual(
    ensureFutureDateRowIds([{ _row_id: 'row_new', date: '2026-03-12', name: 'C' }], repeatableField),
    [{ _row_id: 'row_new', date: '2026-03-12', name: 'C' }],
  );
  assert.deepEqual(
    ensureFutureDateRowIds([{ date: '2026-03-12' }], {
      ...repeatableField,
      children: [{ id: 'name', type: 'text' }],
    }),
    [{ date: '2026-03-12' }],
  );
});

test('previousValues skip unchanged rows by stable row ID, including reordered rows', () => {
  const fields = [{
    id: 'attendees',
    type: 'repeatable_row',
    children: [{ id: 'arrival', type: 'date', future_only: true }],
  }];
  const previousValues = {
    attendees: [
      { _row_id: 'first', arrival: '2026-03-09' },
      { _row_id: 'second', arrival: '2026-03-12' },
    ],
  };
  assert.deepEqual(
    validateFutureDateFields(fields, {
      attendees: [
        { _row_id: 'second', arrival: '2026-03-12' },
        { _row_id: 'first', arrival: '2026-03-09' },
      ],
    }, { now, previousValues }),
    [],
  );
  assert.deepEqual(
    validateFutureDateFields(fields, {
      attendees: [
        { _row_id: 'second', arrival: '2026-03-10' },
        { _row_id: 'first', arrival: '2026-03-09' },
      ],
    }, { now, previousValues }),
    [{
      field_id: 'attendees',
      child_id: 'arrival',
      row: 0,
      message: 'Date must be in the future.',
    }],
  );
});

test('previousValues match legacy no-ID rows one-to-one, including reordered rows', () => {
  const fields = [{
    id: 'people',
    type: 'repeatable_rows',
    children: [{ id: 'date', type: 'date', future_only: true }],
  }];
  const errors = validateFutureDateFields(
    fields,
    { people: [{ date: '2026-03-12' }, { date: '2026-03-09' }] },
    {
      now,
      previousValues: {
        people: [{ date: '2026-03-09' }, { date: '2026-03-12' }],
      },
    },
  );

  assert.deepEqual(errors, []);
});

test('renderer row IDs match persisted legacy rows by exact content', () => {
  const fields = [{
    id: 'people',
    type: 'repeatable_rows',
    children: [{ id: 'date', type: 'date', future_only: true }],
  }];
  const errors = validateFutureDateFields(
    fields,
    {
      people: [
        { _row_id: 'renderer-second', date: '2026-03-12' },
        { _row_id: 'renderer-first', date: '2026-03-09' },
      ],
    },
    {
      now,
      previousValues: {
        people: [{ date: '2026-03-09' }, { date: '2026-03-12' }],
      },
    },
  );

  assert.deepEqual(errors, []);
});

test('legacy row sibling edits retain synthesized IDs and changed dates reject', () => {
  const fields = [{
    id: 'people',
    type: 'repeatable_rows',
    children: [
      { id: 'date', type: 'date', future_only: true },
      { id: 'name', type: 'text' },
    ],
  }];
  const originalRow = { date: '2026-03-12', name: 'Original' };
  const [{ _row_id: synthesizedId }] = ensureFutureDateRowIds([originalRow], fields[0]);
  const errors = validateFutureDateFields(
    fields,
    {
      people: [{
        _row_id: synthesizedId,
        date: '2026-03-10',
        name: 'Sibling edit',
      }],
    },
    {
      now,
      previousValues: { people: [originalRow] },
    },
  );

  assert.deepEqual(errors, [{
    field_id: 'people',
    child_id: 'date',
    row: 0,
    message: 'Date must be in the future.',
  }]);
});

test('legacy deletion and replacement do not get a positional historical exemption', () => {
  const fields = [{
    id: 'people',
    type: 'repeatable_rows',
    children: [
      { id: 'date', type: 'date', future_only: true },
      { id: 'label', type: 'text' },
    ],
  }];
  const errors = validateFutureDateFields(
    fields,
    { people: [{ _row_id: 'new-row', date: '2026-03-09', label: 'new' }] },
    {
      now,
      previousValues: {
        people: [
          { date: '2026-03-09', label: 'old-a' },
          { date: '2026-03-12', label: 'old-b' },
        ],
      },
    },
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].row, 0);
});

test('legacy no-ID repeatable rows still validate changed dates after reordering', () => {
  const fields = [{
    id: 'people',
    type: 'repeatable_rows',
    children: [{ id: 'date', type: 'date', future_only: true }],
  }];
  const errors = validateFutureDateFields(
    fields,
    { people: [{ date: '2026-03-12' }, { date: '2026-03-09' }] },
    {
      now,
      previousValues: {
        people: [{ date: '2026-03-10' }, { date: '2026-03-12' }],
      },
    },
  );

  assert.equal(errors.length, 1);
  assert.equal(errors[0].row, 1);
});
