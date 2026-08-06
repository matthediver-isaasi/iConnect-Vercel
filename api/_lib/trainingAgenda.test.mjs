// Unit tests for training-event agenda helpers (Task #3419):
// - date/detail formatting and email placeholder substitution
// - agenda item type setting parsing + clash-inclusion filtering
// - buildClashWindows (shared client helper): per-line whole-day windows for
//   clash-included types only, event-level fallback for non-training events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgendaLineDates, agendaLineDetail, applyAgendaPlaceholders, escapeHtml, safeHttpUrl } from './trainingAgenda.js';
import { parseAgendaItemTypes, clashIncludedTypeNames, DEFAULT_AGENDA_ITEM_TYPES } from './agendaItemTypes.js';
import { buildClashWindows } from '../../client/src/lib/eventClash.js';

const line = (over = {}) => ({
  id: 'l1',
  start_date: '2026-09-01',
  end_date: '2026-09-01',
  item_type: 'In person',
  description: 'Intro day',
  location: 'London HQ',
  ...over,
});

test('formatAgendaLineDates: single day and range', () => {
  assert.equal(formatAgendaLineDates(line()), 'Tuesday, 1 September 2026');
  assert.match(
    formatAgendaLineDates(line({ end_date: '2026-09-02' })),
    /1 September 2026 – .*2 September 2026/
  );
});

test('agendaLineDetail: picks the type-appropriate detail', () => {
  assert.equal(agendaLineDetail(line()), 'London HQ');
  assert.equal(
    agendaLineDetail(line({ location: null, lms_url: 'https://lms.example.com' })),
    'Learning platform: https://lms.example.com'
  );
  assert.equal(
    agendaLineDetail(line({ location: null, zoom_join_url: 'https://zoom.us/j/1' })),
    'Join link: https://zoom.us/j/1'
  );
});

test('applyAgendaPlaceholders: line tokens and schedule table', () => {
  const agendaData = { lines: [line()], agendaScheduleHtml: '<table>agenda</table>' };
  const out = applyAgendaPlaceholders(
    'On {{agenda_line_date}} ({{agenda_line_type}}): {{agenda_line_description}} at {{agenda_line_detail}}\n{{agenda_schedule}}',
    { agendaData, line: agendaData.lines[0] }
  );
  assert.match(out, /On Tuesday, 1 September 2026 \(In person\): Intro day at London HQ/);
  assert.match(out, /<table>agenda<\/table>/);
});

test('applyAgendaPlaceholders: no line context leaves clean output', () => {
  const out = applyAgendaPlaceholders('Hi {{agenda_line_date}} end', { agendaData: null });
  assert.ok(!out.includes('{{agenda_line_date}}'), 'token must not leak');
});

test('escapeHtml/safeHttpUrl: block HTML injection and unsafe URLs', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>&"\''), '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('https://ok.example.com/x'), 'https://ok.example.com/x');
});

test('applyAgendaPlaceholders: escapes malicious agenda text and $ patterns', () => {
  const evil = line({
    description: '<script>alert(1)</script>',
    item_type: '<b>Online</b>',
    location: '$& $` <i>x</i>',
  });
  const out = applyAgendaPlaceholders(
    '{{agenda_line_description}} | {{agenda_line_type}} | {{agenda_line_detail}}',
    { agendaData: { lines: [evil], agendaScheduleHtml: '' }, line: evil }
  );
  assert.ok(!out.includes('<script>'), 'script tags must be escaped');
  assert.ok(!out.includes('<b>'), 'type HTML must be escaped');
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /\$&amp; \$` &lt;i&gt;x&lt;\/i&gt;/, 'regex replacement patterns must be inert');
});

test('agendaLineDetail: rejects non-http LMS/join URLs', () => {
  assert.equal(agendaLineDetail(line({ location: null, lms_url: 'javascript:alert(1)' })), '');
  assert.equal(agendaLineDetail(line({ location: null, zoom_join_url: 'data:text/html,x' })), '');
});

test('parseAgendaItemTypes: defaults on absent/invalid, normalizes toggle', () => {
  assert.deepEqual(parseAgendaItemTypes(null), DEFAULT_AGENDA_ITEM_TYPES);
  assert.deepEqual(parseAgendaItemTypes('not json'), DEFAULT_AGENDA_ITEM_TYPES);
  assert.deepEqual(
    parseAgendaItemTypes(JSON.stringify([{ name: ' Lab ', includeInClashChecks: false }, { name: '' }])),
    [{ name: 'Lab', includeInClashChecks: false }]
  );
  // omitted toggle defaults to included
  assert.deepEqual(
    parseAgendaItemTypes(JSON.stringify([{ name: 'Lab' }])),
    [{ name: 'Lab', includeInClashChecks: true }]
  );
});

test('clashIncludedTypeNames: excludes toggled-off types', () => {
  const names = clashIncludedTypeNames(DEFAULT_AGENDA_ITEM_TYPES);
  assert.ok(names.has('in person'));
  assert.ok(names.has('online'));
  assert.ok(!names.has('self study'));
});

test('formatAgendaLineDates: per-line times (Task #3443)', () => {
  // Same-day timed line: "date, start – end".
  assert.equal(
    formatAgendaLineDates(line({ start_time: '09:00:00', end_time: '12:30:00' })),
    'Tuesday, 1 September 2026, 09:00 – 12:30'
  );
  // Multi-day timed range keeps both dates with their times.
  assert.match(
    formatAgendaLineDates(line({ end_date: '2026-09-02', start_time: '09:00', end_time: '17:00' })),
    /1 September 2026, 09:00 – .*2 September 2026, 17:00/
  );
  // Legacy date-only rows are unchanged.
  assert.equal(formatAgendaLineDates(line()), 'Tuesday, 1 September 2026');
});

test('buildClashWindows: timed agenda lines use their real windows (Task #3443)', () => {
  const windows = buildClashWindows({
    isTraining: true,
    agendaLines: [
      { start_date: '2026-09-01', end_date: '', start_time: '09:00', end_time: '10:00', item_type: 'In person' },
      { start_date: '2026-09-01', end_date: '', start_time: '14:30:00', end_time: '', item_type: 'Online' },
    ],
    agendaItemTypes: DEFAULT_AGENDA_ITEM_TYPES,
    eventData: {},
    timezone: 'Europe/London',
    title: 'Course',
  });
  assert.equal(windows.length, 2);
  // Timed line: exact window, so a 09:00–10:00 session can't clash with an
  // afternoon event.
  assert.equal(windows[0].start, '2026-09-01T09:00:00');
  assert.equal(windows[0].end, '2026-09-01T10:00:59');
  // Missing end time falls back to end-of-day; HH:MM:SS input normalised.
  assert.equal(windows[1].start, '2026-09-01T14:30:00');
  assert.equal(windows[1].end, '2026-09-01T23:59:59');
});

test('buildClashWindows: training uses per-line whole-day windows for date-only lines, clash-included only', () => {
  const windows = buildClashWindows({
    isTraining: true,
    agendaLines: [
      { start_date: '2026-09-01', end_date: '', item_type: 'In person' },
      { start_date: '2026-09-02', end_date: '2026-09-03', item_type: 'Online' },
      { start_date: '2026-09-04', end_date: '', item_type: 'Self study' },
      { start_date: '', item_type: 'In person' }, // no date -> skipped
    ],
    agendaItemTypes: DEFAULT_AGENDA_ITEM_TYPES,
    eventData: { start_date: '2026-09-01T00:00:00', end_date: '2026-09-04T23:59:00' },
    timezone: 'Europe/London',
    title: 'Course',
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].start, '2026-09-01T00:00:00');
  assert.equal(windows[0].end, '2026-09-01T23:59:59');
  assert.equal(windows[1].start, '2026-09-02T00:00:00');
  assert.equal(windows[1].end, '2026-09-03T23:59:59');
});

test('buildClashWindows: non-training falls back to the event span', () => {
  const windows = buildClashWindows({
    isTraining: false,
    agendaLines: [],
    agendaItemTypes: DEFAULT_AGENDA_ITEM_TYPES,
    eventData: { start_date: '2026-09-01T09:00:00', end_date: '2026-09-01T17:00:00' },
    timezone: 'Europe/London',
    title: 'Simple',
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start, '2026-09-01T09:00:00');
  assert.equal(windows[0].label, 'Simple');
});
