/**
 * Focused tests for immediate event timing behaviour (Task #3691).
 * Validates that the shared helpers imported by client render paths behave
 * correctly without touching shared/eventTiming.js itself.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  isImmediateEvent,
  isTbcEvent,
  isEventInPast,
  getEventTimingSortBucket,
  compareEventsByTiming,
  suppressImmediateSchedule,
  canUseImmediateTiming,
  normalizeSimpleEventTiming,
  resolveSimpleEventOnlineState,
  SIMPLE_EVENT_TIMING,
} from '../../../shared/eventTiming.js';

// ---------------------------------------------------------------------------
// isImmediateEvent
// ---------------------------------------------------------------------------
test('isImmediateEvent returns true for status string "immediate"', () => {
  assert.equal(isImmediateEvent('immediate'), true);
});

test('isImmediateEvent returns true for event object with status "immediate"', () => {
  assert.equal(isImmediateEvent({ status: 'immediate' }), true);
});

test('isImmediateEvent returns false for "published"', () => {
  assert.equal(isImmediateEvent('published'), false);
});

test('isImmediateEvent returns false for "tbc"', () => {
  assert.equal(isImmediateEvent('tbc'), false);
});

test('isImmediateEvent returns false for null/undefined', () => {
  assert.equal(isImmediateEvent(null), false);
  assert.equal(isImmediateEvent(undefined), false);
});

// ---------------------------------------------------------------------------
// isTbcEvent
// ---------------------------------------------------------------------------
test('isTbcEvent returns true for "tbc"', () => {
  assert.equal(isTbcEvent('tbc'), true);
  assert.equal(isTbcEvent({ status: 'tbc' }), true);
});

test('isTbcEvent returns false for "immediate"', () => {
  assert.equal(isTbcEvent('immediate'), false);
});

// ---------------------------------------------------------------------------
// isEventInPast — immediate events are NEVER past
// ---------------------------------------------------------------------------
test('isEventInPast returns false for immediate event regardless of date', () => {
  const pastDate = new Date(Date.now() - 86400_000 * 10).toISOString();
  const immediateEvent = { status: 'immediate', start_date: pastDate, end_date: pastDate };
  assert.equal(isEventInPast(immediateEvent), false);
});

test('isEventInPast returns true for scheduled event with past end_date', () => {
  const pastDate = new Date(Date.now() - 86400_000 * 2).toISOString();
  const scheduledEvent = { status: 'published', end_date: pastDate };
  assert.equal(isEventInPast(scheduledEvent), true);
});

test('isEventInPast returns false for TBC event with no date', () => {
  assert.equal(isEventInPast({ status: 'tbc' }), false);
});

// ---------------------------------------------------------------------------
// getEventTimingSortBucket
// ---------------------------------------------------------------------------
test('getEventTimingSortBucket: scheduled = 0, immediate = 1, tbc/no-date = 2', () => {
  assert.equal(getEventTimingSortBucket({ status: 'published', start_date: '2025-06-01' }), 0);
  assert.equal(getEventTimingSortBucket({ status: 'immediate' }), 1);
  assert.equal(getEventTimingSortBucket({ status: 'tbc' }), 2);
  assert.equal(getEventTimingSortBucket({ status: 'published' }), 2); // no start_date
});

// ---------------------------------------------------------------------------
// compareEventsByTiming — ordering guarantees
// ---------------------------------------------------------------------------
test('compareEventsByTiming sorts scheduled before immediate before TBC', () => {
  const scheduled = { status: 'published', start_date: '2025-09-01', title: 'B', id: '1' };
  const immediate = { status: 'immediate', title: 'A', id: '2' };
  const tbc = { status: 'tbc', title: 'C', id: '3' };

  const events = [tbc, immediate, scheduled];
  events.sort(compareEventsByTiming);

  assert.equal(events[0], scheduled, 'scheduled should be first');
  assert.equal(events[1], immediate, 'immediate should be second');
  assert.equal(events[2], tbc, 'tbc should be last');
});

test('compareEventsByTiming sorts multiple scheduled events chronologically', () => {
  const a = { status: 'published', start_date: '2025-10-01', title: 'A', id: '1' };
  const b = { status: 'published', start_date: '2025-08-01', title: 'B', id: '2' };
  const c = { status: 'published', start_date: '2025-09-01', title: 'C', id: '3' };

  const events = [a, b, c];
  events.sort(compareEventsByTiming);

  assert.equal(events[0], b);
  assert.equal(events[1], c);
  assert.equal(events[2], a);
});

test('compareEventsByTiming sorts multiple immediate events deterministically by title then id', () => {
  const x = { status: 'immediate', title: 'Zoom Workshop', id: 'z' };
  const y = { status: 'immediate', title: 'Agile Training', id: 'a' };

  const events = [x, y];
  events.sort(compareEventsByTiming);

  assert.equal(events[0], y, 'Agile comes before Zoom alphabetically');
  assert.equal(events[1], x);
});

test('compareEventsByTiming: immediate never lands after TBC', () => {
  const immediate = { status: 'immediate', title: 'Z', id: 'z' };
  const tbc = { status: 'tbc', title: 'A', id: 'a' };

  assert.ok(compareEventsByTiming(immediate, tbc) < 0, 'immediate should sort before tbc');
});

// ---------------------------------------------------------------------------
// suppressImmediateSchedule
// ---------------------------------------------------------------------------
test('suppressImmediateSchedule clears schedule fields for immediate events', () => {
  const event = {
    status: 'immediate',
    start_date: '2025-06-01',
    end_date: '2025-06-02',
    timezone: 'Europe/London',
    zoom_webinar_id: 'wid',
    zoom_meeting_id: 'mid',
    registration_closes_at: '2025-05-31',
    is_training: true,
    agenda_summary: [{ id: '1' }],
    title: 'Test Event',
  };

  const result = suppressImmediateSchedule(event);

  assert.equal(result.start_date, null);
  assert.equal(result.end_date, null);
  assert.equal(result.timezone, null);
  assert.equal(result.zoom_webinar_id, null);
  assert.equal(result.zoom_meeting_id, null);
  assert.equal(result.registration_closes_at, null);
  assert.equal(result.is_training, false);
  assert.equal(result.agenda_summary, undefined);
  assert.equal(result.title, 'Test Event', 'title should be untouched');
  assert.equal(result.status, 'immediate', 'status should be untouched');
});

test('suppressImmediateSchedule is a no-op for non-immediate events', () => {
  const event = { status: 'published', start_date: '2025-06-01', title: 'Scheduled' };
  const result = suppressImmediateSchedule(event);
  assert.equal(result.start_date, '2025-06-01');
  assert.equal(result, event, 'should return the same object reference');
});

// ---------------------------------------------------------------------------
// canUseImmediateTiming — Task #3691 editor guard
// ---------------------------------------------------------------------------
test('canUseImmediateTiming returns true for a plain standard event', () => {
  assert.equal(canUseImmediateTiming({}), true);
  assert.equal(canUseImmediateTiming({ isTraining: false, isComplex: false, isGroupLimited: false }), true);
});

test('canUseImmediateTiming returns false when isTraining is true', () => {
  assert.equal(canUseImmediateTiming({ isTraining: true }), false);
});

test('canUseImmediateTiming returns false when isComplex is true', () => {
  assert.equal(canUseImmediateTiming({ isComplex: true }), false);
});

test('canUseImmediateTiming returns false when isGroupLimited is true', () => {
  assert.equal(canUseImmediateTiming({ isGroupLimited: true }), false);
});

test('canUseImmediateTiming returns false when multiple flags are true', () => {
  assert.equal(canUseImmediateTiming({ isTraining: true, isGroupLimited: true }), false);
});

// ---------------------------------------------------------------------------
// normalizeSimpleEventTiming — save-time safety for Task #3691 editor logic
// ---------------------------------------------------------------------------
test('normalizeSimpleEventTiming returns immediate for eligible event', () => {
  const result = normalizeSimpleEventTiming(SIMPLE_EVENT_TIMING.IMMEDIATE, {
    isTraining: false,
    isComplex: false,
    isGroupLimited: false,
  });
  assert.equal(result, SIMPLE_EVENT_TIMING.IMMEDIATE);
});

test('normalizeSimpleEventTiming falls back to published when training + immediate', () => {
  const result = normalizeSimpleEventTiming(SIMPLE_EVENT_TIMING.IMMEDIATE, {
    isTraining: true,
    isComplex: false,
    isGroupLimited: false,
  });
  assert.equal(result, SIMPLE_EVENT_TIMING.SCHEDULED);
});

test('normalizeSimpleEventTiming falls back to published when group-limited + immediate', () => {
  const result = normalizeSimpleEventTiming(SIMPLE_EVENT_TIMING.IMMEDIATE, {
    isTraining: false,
    isComplex: false,
    isGroupLimited: true,
  });
  assert.equal(result, SIMPLE_EVENT_TIMING.SCHEDULED);
});

test('normalizeSimpleEventTiming preserves tbc status', () => {
  const result = normalizeSimpleEventTiming(SIMPLE_EVENT_TIMING.TBC, {});
  assert.equal(result, SIMPLE_EVENT_TIMING.TBC);
});

test('normalizeSimpleEventTiming defaults unrecognised status to published', () => {
  const result = normalizeSimpleEventTiming('unknown', {});
  assert.equal(result, SIMPLE_EVENT_TIMING.SCHEDULED);
});

test('normalizeSimpleEventTiming returns published for published status', () => {
  const result = normalizeSimpleEventTiming(SIMPLE_EVENT_TIMING.SCHEDULED, {});
  assert.equal(result, SIMPLE_EVENT_TIMING.SCHEDULED);
});

test('CreateEvent declares training state before deriving immediate eligibility', () => {
  const source = readFileSync(resolve('client/src/pages/CreateEvent.jsx'), 'utf8');
  const trainingStateIndex = source.indexOf('const [isTraining, setIsTraining] = useState');
  const eligibilityIndex = source.indexOf('const canUseImmediate = canUseImmediateTiming');
  assert.ok(trainingStateIndex >= 0);
  assert.ok(eligibilityIndex > trainingStateIndex);
});

test('TBC saves retain timezone while immediate saves clear it', () => {
  for (const file of ['client/src/pages/CreateEvent.jsx', 'client/src/pages/EditEvent.jsx']) {
    const source = readFileSync(resolve(file), 'utf8');
    assert.match(source, /timezone: isImmediateSave \? null :/);
  }
});

test('an immediate online event stays online when loaded and saved unchanged', () => {
  const loadedOnline = resolveSimpleEventOnlineState({
    status: SIMPLE_EVENT_TIMING.IMMEDIATE,
    is_online: true,
    zoom_webinar_id: null,
    zoom_meeting_id: null,
  });
  assert.equal(loadedOnline, true);

  const source = readFileSync(resolve('client/src/pages/EditEvent.jsx'), 'utf8');
  assert.match(source, /setIsOnlineEvent\(resolveSimpleEventOnlineState\(event, formData\.location\)\)/);
  assert.match(source, /is_online: isOnlineEvent/);
});

test('TBC online-state initialization retains its existing offline behavior', () => {
  assert.equal(
    resolveSimpleEventOnlineState({ status: SIMPLE_EVENT_TIMING.TBC, is_online: true }),
    false,
  );
});
