// Tests for the rich complex-event confirmation schedule builder and the
// per-session ICS output (schedule placeholder + full-programme ICS task).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionScheduleHtml } from './eventConfirmationEmail.js';
import { buildIcs, buildSessionUid } from './icsBuilder.js';

const TZ = 'Europe/London';

const sessions = [
  {
    id: 's1',
    title: 'Opening Keynote & Welcome',
    start_time: '2026-09-01T08:00:00Z', // 09:00 London (BST)
    end_time: '2026-09-01T09:00:00Z',
    delivery_mode: 'in_person',
    location: 'Main Hall, Floor 2',
    track_name: 'Plenary',
  },
  {
    id: 's2',
    title: 'Virtual Workshop <Advanced>',
    start_time: '2026-09-01T10:00:00Z',
    end_time: '2026-09-01T11:30:00Z',
    delivery_mode: 'virtual',
    zoom_join_url: 'https://zoom.us/j/123?pwd=a&b=c',
    track_name: 'Tech Track',
  },
  {
    id: 's3',
    title: 'Day Two Hybrid Panel',
    start_time: '2026-09-02T09:00:00Z',
    end_time: '2026-09-02T10:00:00Z',
    delivery_mode: 'hybrid',
    location: 'Room 4',
    zoom_join_url: 'https://zoom.us/j/456',
  },
];

test('schedule groups sessions by day in event timezone', () => {
  const html = buildSessionScheduleHtml(sessions, TZ);
  const firstDay = html.indexOf('Tuesday, 1 September 2026');
  const secondDay = html.indexOf('Wednesday, 2 September 2026');
  assert.ok(firstDay >= 0, 'day 1 heading present');
  assert.ok(secondDay > firstDay, 'day 2 heading after day 1');
  // Times rendered in event timezone (BST = UTC+1)
  assert.match(html, /09:00&#8211;10:00/);
});

test('schedule escapes titles and renders location, online and join link', () => {
  const html = buildSessionScheduleHtml(sessions, TZ);
  assert.ok(html.includes('Opening Keynote &amp; Welcome'));
  assert.ok(html.includes('Virtual Workshop &lt;Advanced&gt;'));
  assert.ok(html.includes('Main Hall, Floor 2'));
  assert.ok(html.includes('>Join online</a>'));
  assert.ok(html.includes('https://zoom.us/j/123?pwd=a&amp;b=c'));
  // Hybrid shows both location and Online
  assert.match(html, /Room 4 &middot; Online/);
  // In-person session without zoom has no join link in its row
  const s1Row = html.slice(html.indexOf('Opening Keynote'), html.indexOf('Virtual Workshop'));
  assert.ok(!s1Row.includes('Join online'));
});

test('schedule renders track badges with stored track colour', () => {
  const html = buildSessionScheduleHtml(sessions, TZ, {
    trackColours: { plenary: '#10b981', 'tech track': 'not-a-colour' },
  });
  assert.ok(html.includes('border:1px solid #10b981'));
  assert.ok(html.includes('>Plenary</span>'));
  // Invalid colour falls back to neutral grey
  assert.ok(html.includes('border:1px solid #6b7280'));
});

test('schedule is email-safe markup and omits descriptions', () => {
  const withDesc = sessions.map((s) => ({ ...s, description: '<p>Very long description</p>' }));
  const html = buildSessionScheduleHtml(withDesc, TZ);
  assert.ok(!/flex|grid|@media/i.test(html));
  assert.ok(!html.includes('Very long description'));
  assert.ok(html.includes('<table'));
});

test('sessions without start_time go into a TBC bucket; empty input yields empty string', () => {
  const html = buildSessionScheduleHtml([{ id: 'x', title: 'Mystery' }], TZ);
  assert.ok(html.includes('Date to be confirmed'));
  assert.equal(buildSessionScheduleHtml([], TZ), '');
});

test('ICS has one VEVENT per session with unique UIDs, UTC-correct times and escaping', () => {
  const entries = sessions.map((s) => ({
    uid: buildSessionUid('bk1', s.id),
    title: `Big Event — ${s.title}`,
    start: s.start_time,
    end: s.end_time,
    location: s.delivery_mode === 'virtual' ? s.zoom_join_url : (s.location || ''),
    url: s.zoom_join_url || undefined,
  }));
  const ics = buildIcs(entries);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
  const veventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
  assert.equal(veventCount, 3);
  const uids = [...ics.matchAll(/UID:([^\r\n]+)/g)].map((m) => m[1]);
  assert.equal(new Set(uids).size, 3);
  assert.ok(ics.includes('DTSTART:20260901T080000Z'));
  assert.ok(ics.includes('DTEND:20260901T090000Z'));
  // Commas escaped in LOCATION per RFC5545
  assert.ok(ics.includes('LOCATION:Main Hall\\, Floor 2'));
  // Every VEVENT has DTSTART and DTEND
  assert.equal((ics.match(/DTSTART/g) || []).length, 3);
  assert.equal((ics.match(/DTEND/g) || []).length, 3);
  // CRLF line endings
  assert.ok(ics.includes('\r\n'));
});
