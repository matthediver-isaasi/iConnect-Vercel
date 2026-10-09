import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getZoomWebinarEndTime } from './zoomWebinarTiming.js';

const start_time = '2026-12-14T13:30:00Z';
test('local 180-minute webinar ends at 16:30, not the one-hour default', () => {
  assert.equal(getZoomWebinarEndTime({ start_time, duration_minutes: 180 }), '2026-12-14T16:30:00.000Z');
});
test('local duration takes precedence over raw-provider compatibility field', () => {
  assert.equal(getZoomWebinarEndTime({ start_time, duration_minutes: '90', duration: 60 }), '2026-12-14T15:00:00.000Z');
});
test('supports raw Zoom duration and the existing missing-duration default', () => {
  assert.equal(getZoomWebinarEndTime({ start_time, duration: 120 }), '2026-12-14T15:30:00.000Z');
  assert.equal(getZoomWebinarEndTime({ start_time }), '2026-12-14T14:30:00.000Z');
});
test('adds elapsed minutes across midnight and timezone offsets', () => {
  assert.equal(getZoomWebinarEndTime({ start_time: '2026-12-14T23:30:00+01:00', duration_minutes: 180 }), '2026-12-15T01:30:00.000Z');
});
test('rejects invalid supplied durations instead of silently replacing them', () => {
  for (const duration_minutes of [0, -1, 'invalid']) {
    assert.throws(() => getZoomWebinarEndTime({ start_time, duration_minutes }));
  }
});
test('Create Event uses the tested webinar duration resolver', () => {
  const source = readFileSync(new URL('../client/src/pages/CreateEvent.jsx', import.meta.url), 'utf8');
  assert.match(source, /const endTime = getZoomWebinarEndTime\(selectedWebinar\)/);
  assert.doesNotMatch(source, /selectedWebinar\.duration \|\| 60/);
});
