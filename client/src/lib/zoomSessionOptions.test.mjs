import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { upcomingZoomOptions } from './zoomSessionOptions.js';

const now = Date.parse('2026-11-13T12:00:00Z');
const item = (id, topic, overrides = {}) => ({
  id, topic, start_time: '2026-11-14T12:00:00Z', status: 'scheduled', ...overrides,
});
test('upcoming options use case-insensitive A–Z ordering with stable identical-name ties', () => {
  const rows = [item('3', 'Zebra'), item('2', 'alpha'), item('1', 'Alpha'), item('4', 'Beta')];
  assert.deepEqual(upcomingZoomOptions(rows, '', now).map(row => row.id), ['1', '2', '4', '3']);
  assert.equal(rows[0].id, '3', 'must not mutate shared cached data');
});
test('forward typing matches names case-insensitively, including literal punctuation', () => {
  const rows = [item('1', 'Clinical Trials (2026)'), item('2', 'Clinical practice'), item('3', 'Trials')];
  assert.deepEqual(upcomingZoomOptions(rows, ' clinical t ', now).map(row => row.id), ['1']);
  assert.deepEqual(upcomingZoomOptions(rows, '(2026)', now).map(row => row.id), ['1']);
  assert.equal(upcomingZoomOptions(rows, 'missing', now).length, 0);
});
test('past, started, cancelled, finished and undated items cannot be newly selected', () => {
  const rows = [
    item('past', 'A', { start_time: '2026-11-12T12:00:00Z' }),
    item('now', 'B', { start_time: '2026-11-13T12:00:00Z' }),
    item('offset-past', 'C', { start_time: '2026-11-13T13:00:00+02:00' }),
    item('cancelled', 'D', { status: 'cancelled' }),
    item('ended', 'E', { status: 'ended' }),
    item('missing', 'F', { start_time: null }),
    item('invalid', 'G', { start_time: 'invalid' }),
    item('future', 'H'),
  ];
  assert.deepEqual(upcomingZoomOptions(rows, '', now).map(row => row.id), ['future']);
  assert.deepEqual(upcomingZoomOptions(rows, '', Date.parse('2026-11-15T00:00:00Z')), []);
});
test('all event pickers use isolated upcoming queries and preserve local/provider ID contracts', () => {
  for (const path of ['client/src/pages/CreateEvent.jsx', 'client/src/components/events/TrainingAgendaEditor.jsx', 'client/src/components/events/ZoomSessionConfig.jsx']) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /event-link-options/);
    assert.match(source, /upcoming=true&status=scheduled/);
    assert.match(source, /<ZoomSessionPicker/);
  }
  const config = readFileSync('client/src/components/events/ZoomSessionConfig.jsx', 'utf8');
  assert.match(config, /getValue=\{zoomIdOf\}/);
  assert.match(config, /item.zoom_webinar_id : item.zoom_meeting_id/);
  const picker = readFileSync('client/src/components/events/ZoomSessionPicker.jsx', 'utf8');
  assert.match(picker, /const localId = item => String\(item.id\)/);
  assert.match(picker, /shouldFilter=\{false\}/, 'Command must not re-rank A–Z results');
  assert.match(picker, /The existing link is retained/);
});
