import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getResourceShowcaseSourceMode,
  resolveSpecificResourceShowcaseItems,
} from './resourceShowcaseSelection.js';

test('legacy Resource showcase content remains automatic', () => {
  assert.equal(getResourceShowcaseSourceMode({}), 'automatic');
  assert.equal(getResourceShowcaseSourceMode({ sourceMode: 'automatic' }), 'automatic');
  assert.equal(getResourceShowcaseSourceMode({ sourceMode: 'specific' }), 'specific');
});

test('specific Resource showcase selection follows saved order and omits unavailable or duplicate IDs', () => {
  const resources = [
    { id: 'newest', title: 'Newest resource' },
    { id: 'oldest', title: 'Oldest resource' },
    { id: 'locked', title: 'Member resource', is_locked: true },
  ];

  const result = resolveSpecificResourceShowcaseItems(
    resources,
    ['oldest', 'missing', 'locked', 'oldest', '', 'newest'],
  );

  assert.deepEqual(result.map((resource) => resource.id), ['oldest', 'locked', 'newest']);
  assert.equal(result[1], resources[2], 'selected resources retain the public-feed record used by card rendering');
});