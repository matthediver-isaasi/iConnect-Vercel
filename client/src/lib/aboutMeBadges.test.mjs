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
  assert.equal(badges[0], group);
});