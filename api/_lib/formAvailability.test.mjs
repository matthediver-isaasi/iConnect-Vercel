import test from 'node:test';
import assert from 'node:assert/strict';
import { isFormScheduleAvailable } from './formAvailability.js';

const now = Date.parse('2026-08-24T12:00:00.000Z');

test('forms without a valid elapsed deactivation remain available', () => {
  assert.equal(isFormScheduleAvailable({}, now), true);
  assert.equal(isFormScheduleAvailable({ deactivate_at: null }, now), true);
  assert.equal(isFormScheduleAvailable({ deactivate_at: 'not-a-date' }, now), true);
  assert.equal(isFormScheduleAvailable({ deactivate_at: '2026-08-24T12:00:00.001Z' }, now), true);
});

test('forms deactivate at the configured instant', () => {
  assert.equal(isFormScheduleAvailable({ deactivate_at: '2026-08-24T12:00:00.000Z' }, now), false);
  assert.equal(isFormScheduleAvailable({ deactivate_at: '2026-08-24T11:59:59.999Z' }, now), false);
});