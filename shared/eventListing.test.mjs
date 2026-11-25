import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterListedEvents, isPrivateEvent } from './eventListing.js';

const events = [{ id: 'a' }, { id: 'b', is_private: true }, { id: 'c', is_private: false }];
test('private events are unlisted for non-admins only', () => {
  assert.deepEqual(filterListedEvents(events).map(e => e.id), ['a', 'c']);
  assert.deepEqual(filterListedEvents(events, { isAdmin: true }).map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(filterListedEvents(null), []);
  assert.equal(isPrivateEvent({ is_private: 'true' }), false);
});

test('Events private toggle is opt-in, uses draft RBAC, and covers both event types', () => {
  const page = readFileSync(new URL('../client/src/pages/Events.jsx', import.meta.url), 'utf8');
  assert.match(page, /const \[showPrivateEvents, setShowPrivateEvents\] = useState\(false\)/);
  assert.match(page, /const canToggleDrafts = !!memberInfo && !hookIsFeatureExcluded\('events\.browse-events\.toggle-drafts'\)/);
  assert.match(page, /const includePrivateEvents = canToggleDrafts && showPrivateEvents/);
  for (const source of ['simpleEvents', 'groupVisibleComplexEvents']) {
    assert.ok(page.includes(`filterListedEvents(${source}, { isAdmin: includePrivateEvents })`));
  }
  assert.match(page, /\{canToggleDrafts && \([\s\S]*?id="show-private-events"[\s\S]*?onCheckedChange=\{setShowPrivateEvents\}/);
  for (const canToggleDrafts of [false, true]) {
    for (const showPrivateEvents of [false, true]) {
      const includePrivateEvents = canToggleDrafts && showPrivateEvents;
      assert.equal(filterListedEvents(events, { isAdmin: includePrivateEvents }).length,
        includePrivateEvents ? 3 : 2);
    }
  }
});
