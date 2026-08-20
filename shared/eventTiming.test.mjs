import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES,
  PUBLIC_SIMPLE_EVENT_STATUSES,
  canUseImmediateTiming,
  compareEventsByTiming,
  isEventInPast,
  isImmediateEvent,
  normalizeSimpleEventTiming,
  normalizeSimpleEventWrite,
  suppressImmediateSchedule,
} from './eventTiming.js';

test('immediate is a public simple-event status, including direct detail lookup', () => {
  assert.deepEqual(PUBLIC_SIMPLE_EVENT_STATUSES, ['published', 'tbc', 'immediate']);
  assert.deepEqual(PUBLIC_SIMPLE_EVENT_DETAIL_STATUSES, [
    'published',
    'tbc',
    'immediate',
    'draft',
  ]);
});

test('immediate is limited to standard simple events', () => {
  assert.equal(canUseImmediateTiming(), true);
  assert.equal(canUseImmediateTiming({ isTraining: true }), false);
  assert.equal(canUseImmediateTiming({ isComplex: true }), false);
  assert.equal(canUseImmediateTiming({ isGroupLimited: true }), false);
  assert.equal(normalizeSimpleEventTiming('immediate'), 'immediate');
  assert.equal(normalizeSimpleEventTiming('immediate', { isTraining: true }), 'published');
  assert.equal(normalizeSimpleEventTiming('immediate', { isGroupLimited: true }), 'published');
  assert.equal(normalizeSimpleEventTiming('tbc', { isTraining: true }), 'tbc');
});

test('eligible immediate API writes clear schedule fields', () => {
  const result = normalizeSimpleEventWrite({
    status: 'immediate',
    is_training: false,
    start_date: '2026-09-01T09:00:00Z',
    timezone: 'Europe/London',
    zoom_meeting_id: '123',
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.status, 'immediate');
  assert.equal(result.body.is_training, false);
  for (const field of [
    'start_date',
    'end_date',
    'registration_closes_at',
    'timezone',
    'zoom_webinar_id',
    'zoom_meeting_id',
  ]) {
    assert.equal(result.body[field], null);
  }
});

test('immediate training API writes normalize to scheduled on create and partial PATCH', () => {
  const createResult = normalizeSimpleEventWrite({
    status: 'immediate',
    is_training: true,
    start_date: '2026-09-01T09:00:00Z',
  });
  assert.equal(createResult.ok, true);
  assert.equal(createResult.body.status, 'published');
  assert.equal(createResult.body.start_date, '2026-09-01T09:00:00Z');

  const patchResult = normalizeSimpleEventWrite(
    { is_training: true },
    { status: 'immediate', is_training: false, member_group_id: null },
  );
  assert.equal(patchResult.ok, true);
  assert.equal(patchResult.body.status, 'published');
  assert.equal(patchResult.body.is_training, true);
});

test('immediate group API writes are rejected', () => {
  assert.equal(
    normalizeSimpleEventWrite({
      status: 'immediate',
      is_training: false,
      member_group_id: 'group-1',
    }).ok,
    false,
  );
});

test('immediate schedule fields are defensively cleared without mutating input', () => {
  const event = {
    status: 'immediate',
    start_date: '2026-08-20T10:00:00Z',
    end_date: '2026-08-20T11:00:00Z',
    registration_closes_at: '2026-08-19T10:00:00Z',
    timezone: 'Europe/London',
    zoom_webinar_id: 'zoom-1',
    zoom_meeting_id: 'zoom-2',
    is_training: true,
    agenda_summary: [{ start_date: '2026-08-20' }],
    title: 'On demand',
  };
  const result = suppressImmediateSchedule(event);
  assert.notEqual(result, event);
  assert.equal(result.title, 'On demand');
  assert.equal(result.is_training, false);
  assert.equal(result.agenda_summary, undefined);
  for (const field of [
    'start_date',
    'end_date',
    'registration_closes_at',
    'timezone',
    'zoom_webinar_id',
    'zoom_meeting_id',
  ]) {
    assert.equal(result[field], null);
  }
  assert.equal(event.start_date, '2026-08-20T10:00:00Z');
});

test('immediate events are never past and sort between scheduled and TBC events', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  assert.equal(
    isEventInPast({ status: 'immediate', end_date: '2020-01-01T00:00:00Z' }, now),
    false,
  );

  const events = [
    { id: 't', title: 'TBC', status: 'tbc', start_date: null },
    { id: 'i2', title: 'Zulu', status: 'immediate', start_date: null },
    { id: 's2', title: 'Later', status: 'published', start_date: '2026-09-02T10:00:00Z' },
    { id: 'i1', title: 'Alpha', status: 'immediate', start_date: null },
    { id: 's1', title: 'Sooner', status: 'published', start_date: '2026-09-01T10:00:00Z' },
  ];
  events.sort(compareEventsByTiming);
  assert.deepEqual(events.map((event) => event.id), ['s1', 's2', 'i1', 'i2', 't']);
});