import test from 'node:test';
import assert from 'node:assert/strict';
import { isResourceReleased, applyResourceReleaseFilter } from './resourceRelease.js';

const now = Date.parse('2026-06-01T12:00:00Z');
test('release instant is inclusive, with null/legacy empty allowed and invalid dates denied', () => {
  for (const release_date of [null, undefined, '', ' ', '2026-06-01T11:59:59.999Z',
    '2026-06-01T12:00:00Z', '2026-06-01T14:00:00+02:00']) {
    assert.equal(isResourceReleased({ release_date }, now), true);
  }
  for (const release_date of ['2026-06-01T12:00:00.001Z', 'invalid', false, 0]) {
    assert.equal(isResourceReleased({ release_date }, now), false);
  }
  assert.equal(isResourceReleased(null, now), false);
});
test('query predicate uses null or inclusive timestamp without invalid empty timestamp literal', () => {
  let filter;
  const query = { or(value) { filter = value; return this; } };
  assert.equal(applyResourceReleaseFilter(query, now), query);
  assert.equal(filter, 'release_date.is.null,release_date.lte.2026-06-01T12:00:00.000Z');
});