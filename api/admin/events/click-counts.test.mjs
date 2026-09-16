import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./click-counts.js', import.meta.url), 'utf8');
const attendeeSource = await readFile(new URL('./attendee-counts.js', import.meta.url), 'utf8');

test('click counts reuse attendee authorization and keep simple/complex namespaces separate', () => {
  assert.match(source, /filterCountableEvents/);
  assert.match(source, /events\.browse-events\.view-attendees/);
  assert.match(source, /getCallerGroupMembershipIds/);
  assert.match(source, /getCallerGroupEventsAccess/);
  assert.match(source, /context\.memberExcludedFeatures/);
  assert.match(attendeeSource, /context\.memberExcludedFeatures/);
  assert.match(source, /p_simple_event_ids/);
  assert.match(source, /p_complex_event_ids/);
  assert.match(source, /const counts = \{\s*simple:/);
  assert.match(source, /const counts = \{\s*simple:.*complex:/s);
});

test('click counts reject malformed or unbounded requests and do not expose visitor rows', () => {
  assert.match(source, /isUuid/);
  assert.match(source, /Event ids must be UUIDs/);
  assert.match(source, /MAX_EVENT_IDS = 500/);
  assert.doesNotMatch(source, /\.from\(['"]event_card_click['"]\)/);
  assert.match(source, /get_event_card_click_counts/);
});