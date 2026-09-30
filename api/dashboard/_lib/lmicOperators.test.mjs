import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFilter, pruneLmicGroupKeys } from './aggregation.js';
import { deriveRegionBucket } from '../../../shared/countryRegions.js';

// LMIC list fixture: Kenya + India are LMIC; GB/FR are not.
const LMIC = ['KE', 'IN'];

// ---------------------------------------------------------------------------
// Row filtering (matchFilter) — list-typed custom field values
// ---------------------------------------------------------------------------

test('not_lmic list filter matches when ANY element is non-LMIC', () => {
  const f = { operator: 'not_lmic' };
  assert.equal(matchFilter(['Kenya', 'France'], f, LMIC, true), true);
  assert.equal(matchFilter(['France'], f, LMIC, true), true);
  assert.equal(matchFilter(['Kenya', 'India'], f, LMIC, true), false);
  assert.equal(matchFilter([], f, LMIC, true), false);
});

test('lmic and not_lmic are symmetric on unresolvable values (neither matches)', () => {
  const junk = ['Atlantis', 'Not-a-country'];
  assert.equal(matchFilter(junk, { operator: 'lmic' }, LMIC, true), false);
  assert.equal(matchFilter(junk, { operator: 'not_lmic' }, LMIC, true), false);
});

test('not_lmic resolves mixed storage (names, ISO codes, WB-style names)', () => {
  const f = { operator: 'not_lmic' };
  assert.equal(matchFilter(['GB'], f, LMIC, true), true);
  assert.equal(matchFilter(['United Kingdom'], f, LMIC, true), true);
  assert.equal(matchFilter(['KE'], f, LMIC, true), false);
  assert.equal(matchFilter(['Kenya'], f, LMIC, true), false);
});

test('not_lmic with empty tenant list: every resolvable country matches', () => {
  const f = { operator: 'not_lmic' };
  assert.equal(matchFilter(['Kenya'], f, [], true), true);
  assert.equal(matchFilter(['Atlantis'], f, [], true), false);
  // lmic with empty list matches nothing (existing behaviour preserved).
  assert.equal(matchFilter(['Kenya'], { operator: 'lmic' }, [], true), false);
});

test('not_lmic scalar path (system country column)', () => {
  const f = { operator: 'not_lmic' };
  assert.equal(matchFilter('FR', f, LMIC, false), true);
  assert.equal(matchFilter('IN', f, LMIC, false), false);
  assert.equal(matchFilter(null, f, LMIC, false), false);
  assert.equal(matchFilter('garbage', f, LMIC, false), false);
});

test('lmic/not_lmic row-filter complementarity on resolvable single-country rows', () => {
  // For rows whose whole list resolves, every row matches exactly one of
  // the two operators (rows with BOTH an LMIC and a non-LMIC country
  // legitimately match both — any-element semantics).
  for (const value of [['Kenya'], ['India'], ['France'], ['GB']]) {
    const isLmic = matchFilter(value, { operator: 'lmic' }, LMIC, true);
    const isNot = matchFilter(value, { operator: 'not_lmic' }, LMIC, true);
    assert.equal(isLmic !== isNot, true, `expected exactly one match for ${value}`);
  }
});

// ---------------------------------------------------------------------------
// Group-by element pruning (pruneLmicGroupKeys)
// ---------------------------------------------------------------------------

test('pruneLmicGroupKeys invert keeps only non-LMIC codes, normalised to ISO-2', () => {
  const set = new Set(LMIC);
  assert.deepEqual(
    pruneLmicGroupKeys(['Kenya', 'France', 'United Kingdom'], set, { invert: true }),
    ['FR', 'GB'],
  );
  // Mixed storage collapses to one code.
  assert.deepEqual(pruneLmicGroupKeys(['France', 'FR'], set, { invert: true }), ['FR']);
  // No non-LMIC element -> NO bucket (empty array, not "Unspecified").
  assert.deepEqual(pruneLmicGroupKeys(['Kenya', 'India'], set, { invert: true }), []);
  // Unresolvable values are dropped, same as the lmic path.
  assert.deepEqual(pruneLmicGroupKeys(['Atlantis'], set, { invert: true }), []);
});

test('pruneLmicGroupKeys invert works with an empty tenant list', () => {
  assert.deepEqual(
    pruneLmicGroupKeys(['Kenya', 'France'], new Set(), { invert: true }),
    ['KE', 'FR'],
  );
  // Non-invert with empty set keeps existing "match nothing" behaviour.
  assert.deepEqual(pruneLmicGroupKeys(['Kenya'], new Set()), []);
});

test('pruneLmicGroupKeys non-invert behaviour unchanged (regression)', () => {
  const set = new Set(LMIC);
  assert.deepEqual(pruneLmicGroupKeys(['Kenya', 'France'], set), ['KE']);
  assert.deepEqual(pruneLmicGroupKeys(['France'], set), []);
});

// ---------------------------------------------------------------------------
// Region derivation (deriveRegionBucket with lmicInvert)
// ---------------------------------------------------------------------------

test('deriveRegionBucket lmicInvert derives region only from non-LMIC countries', () => {
  const set = new Set(LMIC);
  // Kenya (LMIC, Africa) + France (non-LMIC, Europe): only France counts.
  const bucket = deriveRegionBucket(['Kenya', 'France'], { lmicCodeSet: set, lmicInvert: true });
  assert.equal(typeof bucket, 'string');
  assert.notEqual(bucket, 'Multi-region');
  // Same countries, non-invert: only Kenya counts — different region.
  const lmicBucket = deriveRegionBucket(['Kenya', 'France'], { lmicCodeSet: set });
  assert.notEqual(bucket, lmicBucket);
});

test('deriveRegionBucket lmicInvert returns null when nothing survives', () => {
  const set = new Set(LMIC);
  assert.equal(deriveRegionBucket(['Kenya', 'India'], { lmicCodeSet: set, lmicInvert: true }), null);
  assert.equal(deriveRegionBucket(['Atlantis'], { lmicCodeSet: set, lmicInvert: true }), null);
  assert.equal(deriveRegionBucket([], { lmicCodeSet: set, lmicInvert: true }), null);
});

test('deriveRegionBucket lmicInvert with empty set counts every resolvable country', () => {
  const bucket = deriveRegionBucket(['France'], { lmicCodeSet: new Set(), lmicInvert: true });
  assert.equal(typeof bucket, 'string');
});

test('deriveRegionBucket non-invert behaviour unchanged (regression)', () => {
  const set = new Set(LMIC);
  assert.equal(deriveRegionBucket(['France'], { lmicCodeSet: set }), null);
  assert.equal(typeof deriveRegionBucket(['Kenya'], { lmicCodeSet: set }), 'string');
  assert.equal(deriveRegionBucket(['France']), deriveRegionBucket(['FR']));
});
