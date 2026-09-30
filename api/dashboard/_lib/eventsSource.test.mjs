import test from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_SOURCES } from './sources.js';

test('Events registry is a separate simple/complex event union', () => {
  const source = DASHBOARD_SOURCES.event;
  assert.equal(source.id, 'event');
  assert.equal(source.label, 'Events');
  assert.equal(source.table, 'event');
  assert.equal(source.complexTable, 'complex_event');
  assert.equal(source.isEvent, true);
  assert.equal(source.isBooking, undefined);
  assert.equal(source.timestampField, 'event_start_date');
  assert.deepEqual(source.systemFields.map(field => field.name), [
    'id',
    'event_kind',
    'status',
    'event_start_date',
  ]);
});

test('Events registry exposes all simple and complex event statuses', () => {
  const status = DASHBOARD_SOURCES.event.systemFields.find(field => field.name === 'status');
  assert.deepEqual(status.options.map(option => option.value), [
    'draft',
    'published',
    'tbc',
    'closed',
    'cancelling',
    'immediate',
  ]);
  assert.equal(DASHBOARD_SOURCES.event_booking.label, 'Event Bookings');
  assert.equal(DASHBOARD_SOURCES.event_booking.isBooking, true);
});