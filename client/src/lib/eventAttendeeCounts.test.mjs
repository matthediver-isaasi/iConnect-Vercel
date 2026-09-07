import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildActiveAttendeeCountMap } from './eventAttendeeCounts.js';
import { resolveEventAttendeeCountDisplay } from './eventAttendeeCountDisplay.js';

test('builds separate active attendee totals for multiple events', () => {
  assert.deepEqual(
    buildActiveAttendeeCountMap([
      { event_id: 'event-a', status: 'confirmed' },
      { event_id: 'event-b', status: 'confirmed' },
      { event_id: 'event-a', status: 'pending' },
    ], ['event-a', 'event-b']),
    { 'event-a': 2, 'event-b': 1 },
  );
});

test('keeps zero events and excludes cancelled bookings using dialog rules', () => {
  assert.deepEqual(
    buildActiveAttendeeCountMap([
      { event_id: 'event-a', status: 'cancelled' },
      { event_id: 'event-a', status: null },
      { event_id: 'event-outside-list', status: 'confirmed' },
    ], ['event-a', 'event-zero']),
    { 'event-a': 1, 'event-zero': 0 },
  );
});

test('recomputes from refreshed booking data without retaining stale totals', () => {
  const eventIds = ['event-a'];
  assert.deepEqual(
    buildActiveAttendeeCountMap([{ event_id: 'event-a', status: 'confirmed' }], eventIds),
    { 'event-a': 1 },
  );
  assert.deepEqual(
    buildActiveAttendeeCountMap([{ event_id: 'event-a', status: 'cancelled' }], eventIds),
    { 'event-a': 0 },
  );
});

test('renders zero and non-zero counts without an attendee icon fallback', () => {
  assert.deepEqual(resolveEventAttendeeCountDisplay({ count: 0 }), {
    kind: 'ready',
    text: '0',
    ariaLabel: 'Attendees: 0',
  });
  assert.deepEqual(resolveEventAttendeeCountDisplay({ count: 17 }), {
    kind: 'ready',
    text: '17',
    ariaLabel: 'Attendees: 17',
  });
});

test('uses explicit loading and unavailable count states', () => {
  assert.deepEqual(resolveEventAttendeeCountDisplay({ isLoading: true }), {
    kind: 'loading',
    text: '…',
    ariaLabel: 'Attendee count loading',
  });
  assert.deepEqual(resolveEventAttendeeCountDisplay({ isError: true }), {
    kind: 'unavailable',
    text: '—',
    ariaLabel: 'Attendee count unavailable',
  });
  assert.equal(resolveEventAttendeeCountDisplay().kind, 'unavailable');
});

test('Events counts only visible complex events and supplies counts to shared cards', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../pages/Events.jsx'), 'utf8');
  assert.match(
    source,
    /visibleComplexEvents\.map\(\(event\) => event\.id\)/,
    'hidden complex group events must not be sent to the count endpoint',
  );
  assert.match(source, /attendeeCount=\{eventAttendeeCounts\?\.\[event\.id\]\}/);
  assert.match(source, /attendeeCountLoading=\{eventAttendeeCountsLoading\}/);
  assert.match(source, /attendeeCountError=\{eventAttendeeCountsError\}/);
});

test('group-admin event cards receive their resolved attendee count', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../pages/MemberGroupDetail.jsx'), 'utf8');
  assert.match(source, /isGroupAdmin \|\| !isFeatureExcluded\?\.\('events\.browse-events\.view-attendees'\)/);
  assert.match(source, /attendeeCount=\{groupEventAttendeeCounts\?\.\[event\.id\]\}/);
  assert.match(source, /attendeeCountLoading=\{groupEventAttendeeCountsLoading\}/);
  assert.match(source, /attendeeCountError=\{groupEventAttendeeCountsError\}/);
});

test('shared event cards never restore the attendee head icon for unresolved counts', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../components/events/EventCard.jsx'), 'utf8');
  const actionStart = source.indexOf('data-testid={`button-attendees-event-${event.id}`}');
  const actionEnd = source.indexOf('</Button>', actionStart);
  const attendeeAction = source.slice(actionStart, actionEnd);
  assert.match(source, /const attendeeCountDisplay = resolveEventAttendeeCountDisplay/);
  assert.match(attendeeAction, /attendeeCountDisplay\.(?:kind|text)/);
  assert.doesNotMatch(attendeeAction, /<UsersRound/);
});