import test from 'node:test';
import assert from 'node:assert/strict';
import { filterListedEvents, isPrivateEvent } from './eventListing.js';

const events = [{ id: 'a' }, { id: 'b', is_private: true }, { id: 'c', is_private: false }];
test('private events are unlisted for non-admins only', () => {
  assert.deepEqual(filterListedEvents(events).map(e => e.id), ['a', 'c']);
  assert.deepEqual(filterListedEvents(events, { isAdmin: true }).map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(filterListedEvents(null), []);
  assert.equal(isPrivateEvent({ is_private: 'true' }), false);
});
