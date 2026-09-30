import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickDayAnchorSessions,
  dayKeyInTimezone,
  isAbsoluteReminder,
  calculateScheduledTimeMs
} from './complexEventReminders.js';

test('groups multiple same-day sessions to one anchor (earliest)', () => {
  const sessions = [
    { id: 'a', title: 'Day1 AM', start_time: '2026-09-01T09:00:00Z' },
    { id: 'b', title: 'Day1 PM', start_time: '2026-09-01T14:00:00Z' },
    { id: 'c', title: 'Day2', start_time: '2026-09-02T10:00:00Z' },
    { id: 'd', title: 'Day3 late', start_time: '2026-09-03T16:00:00Z' },
    { id: 'e', title: 'Day3 early', start_time: '2026-09-03T08:00:00Z' }
  ];
  const anchors = pickDayAnchorSessions(sessions, 'UTC');
  assert.equal(anchors.length, 3);
  assert.deepEqual(anchors.map(a => a.session.id), ['a', 'c', 'e']);
  assert.deepEqual(anchors.map(a => a.dayKey), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('anchor selection is deterministic regardless of input order', () => {
  const sessions = [
    { id: 'b', title: 'PM', start_time: '2026-09-01T14:00:00Z' },
    { id: 'a', title: 'AM', start_time: '2026-09-01T09:00:00Z' }
  ];
  const anchors = pickDayAnchorSessions(sessions, 'UTC');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].session.id, 'a');
});

test('uses event timezone for day boundaries', () => {
  // 2026-09-01T23:30Z is 2026-09-02 in Europe/Paris (UTC+2 in summer)
  const sessions = [
    { id: 'x', start_time: '2026-09-01T23:30:00Z' },
    { id: 'y', start_time: '2026-09-02T08:00:00Z' }
  ];
  assert.equal(pickDayAnchorSessions(sessions, 'Europe/Paris').length, 1);
  assert.equal(pickDayAnchorSessions(sessions, 'UTC').length, 2);
});

test('naive (no offset) start_time treated as UTC', () => {
  const anchors = pickDayAnchorSessions([{ id: 'n', start_time: '2026-09-01T09:00:00' }], 'UTC');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].dayKey, '2026-09-01');
});

test('sessions without start_time or invalid dates are skipped', () => {
  const anchors = pickDayAnchorSessions([
    { id: 'a', start_time: null },
    { id: 'b', start_time: 'not-a-date' },
    { id: 'c', start_time: '2026-09-01T09:00:00Z' }
  ], 'UTC');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].session.id, 'c');
});

test('bad timezone falls back to UTC day key', () => {
  assert.equal(dayKeyInTimezone(Date.UTC(2026, 8, 1, 12), 'Not/AZone'), '2026-09-01');
});

test('absolute reminder detection and timing unchanged', () => {
  const abs = { timing_type: 'custom', custom_unit: 'specific_datetime', custom_send_at: '2026-09-01T00:00:00Z' };
  assert.ok(isAbsoluteReminder(abs));
  assert.equal(calculateScheduledTimeMs(0, abs), Date.parse('2026-09-01T00:00:00Z'));
  const rel = { timing_type: '1_day_before' };
  assert.ok(!isAbsoluteReminder(rel));
  const ref = Date.parse('2026-09-03T09:00:00Z');
  assert.equal(calculateScheduledTimeMs(ref, rel), ref - 24 * 3600 * 1000);
});
