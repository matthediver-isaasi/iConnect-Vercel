import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLibraryBadges } from './aboutMeBadges.js';

test('a direct-only badge is retained for About Me visibility', () => {
  assert.deepEqual(mergeLibraryBadges([], [{ id: 'direct' }]).map((badge) => badge.id), ['direct']);
});

test('derived badges remain and direct overlap does not create duplicate cards', () => {
  const group = { id: 'shared', name: 'Derived' };
  const badges = mergeLibraryBadges([group, { id: 'group-only' }], [
    { id: 'shared', name: 'Direct duplicate' },
    { id: 'direct-only' },
  ]);
  assert.deepEqual(badges.map((badge) => badge.id), ['shared', 'group-only', 'direct-only']);
  assert.equal(badges[0].name, 'Direct duplicate');
});

test('group/direct overlap preserves award dates, distinct events and download fields', () => {
  const events = [{ event_id: 'one' }, { event_id: 'two' }];
  const badges = mergeLibraryBadges([{ id: 'shared', image_url: '/group.png' }, { id: 'group' }], [
    { id: 'shared', name: 'Speaker', awarded_at: '2026-01-01', speaker_events: events },
  ]);
  assert.equal(badges.length, 2);
  assert.equal(badges[0].image_url, '/group.png');
  assert.equal(badges[0].awarded_at, '2026-01-01');
  assert.deepEqual(badges[0].speaker_events, events);
});