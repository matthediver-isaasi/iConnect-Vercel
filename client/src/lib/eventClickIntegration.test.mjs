import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, relative), 'utf8');

test('Events opts shared cards into tracking and typed count queries', () => {
  const source = read('../pages/Events.jsx');
  assert.match(source, /useEventClickTracking/);
  assert.match(read('../hooks/useEventClickTracking.js'), /hasConsented/);
  assert.match(source, /useEventClickTracking\(\{ enabled: true \}\)/);
  assert.match(source, /useEventClickCounts/);
  assert.match(source, /eventClickTrackingEnabled\s+eventClickCountEnabled/);
  assert.match(source, /eventClickCountEnabled=\{canViewAttendees\}/);
  assert.match(source, /onAuxClick=\{\(interactionEvent\) => trackEventAuxClick/);
  assert.match(source, /eventClickCountLoading=\{eventClickCountsLoading\}/);
  assert.match(source, /eventClickCountError=\{eventClickCountsError\}/);
});

test('EventCard tracking and native new-tab navigation are explicit listing opt-ins', () => {
  const source = read('../components/events/EventCard.jsx');
  assert.match(source, /eventClickTrackingEnabled = false/);
  assert.match(source, /!eventClickTrackingEnabled \|\| !onEventClick/);
  assert.match(source, /disabled=\{isSoldOut\}/);
  assert.match(source, /navigationInNewTab = false/);
  assert.match(source, /!eventClickTrackingEnabled \|\| !onEventAuxClick/);
  assert.match(source, /onAuxClick=\{navigationInNewTab \? trackEventAuxClick : undefined\}/);
  assert.match(source, /rel: 'noopener noreferrer'/);
  assert.equal((read('../pages/Events.jsx').match(/^\s+navigationInNewTab$/gm) || []).length, 2);
  assert.doesNotMatch(read('../pages/MemberGroupDetail.jsx'), /navigationInNewTab/);
});