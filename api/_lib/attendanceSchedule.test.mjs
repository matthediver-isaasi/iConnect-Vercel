import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaScheduledEndAt, agendaScheduledEndAtWithFallback, localDateTimeToIso } from './attendanceSchedule.js';

test('agenda end uses the event timezone rather than UTC end-of-day', () => {
  assert.equal(
    agendaScheduledEndAt('2026-07-15', '17:30:00', 'Europe/London'),
    '2026-07-15T16:30:00.000Z',
  );
  assert.equal(agendaScheduledEndAt('2026-07-15', null, 'Europe/London'), null);
  assert.equal(
    agendaScheduledEndAtWithFallback('2026-07-15', null, 'Europe/London'),
    '2026-07-15T22:59:59.000Z',
  );
});

test('meeting wall-clock times use the supplied IANA timezone', () => {
  assert.equal(
    localDateTimeToIso('2026-07-15T17:30:00', 'Europe/London'),
    '2026-07-15T16:30:00.000Z',
  );
  assert.equal(
    localDateTimeToIso('2026-07-15T17:30:00Z', 'America/New_York'),
    '2026-07-15T17:30:00.000Z',
  );
});