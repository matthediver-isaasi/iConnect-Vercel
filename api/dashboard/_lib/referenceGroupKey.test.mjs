import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceGroupKey } from './aggregation.js';

const names = new Map([
  ['11111111-1111-1111-1111-111111111111', 'University Member'],
  ['22222222-2222-2222-2222-222222222222', ''],
  ['33333333-3333-3333-3333-333333333333', null],
]);

test('resolves a known reference id to its display name', () => {
  assert.equal(
    referenceGroupKey('11111111-1111-1111-1111-111111111111', names),
    'University Member',
  );
});

test('empty/missing values bucket under Unspecified', () => {
  assert.equal(referenceGroupKey(null, names), 'Unspecified');
  assert.equal(referenceGroupKey(undefined, names), 'Unspecified');
  assert.equal(referenceGroupKey('', names), 'Unspecified');
});

test('ids missing from the map (deleted references) bucket under Unknown, never leak the UUID', () => {
  assert.equal(
    referenceGroupKey('99999999-9999-9999-9999-999999999999', names),
    'Unknown',
  );
});

test('references whose row has an empty or null name fall back to Unknown', () => {
  assert.equal(
    referenceGroupKey('22222222-2222-2222-2222-222222222222', names),
    'Unknown',
  );
  assert.equal(
    referenceGroupKey('33333333-3333-3333-3333-333333333333', names),
    'Unknown',
  );
});

test('non-string ids are matched via string normalisation', () => {
  const numeric = new Map([['42', 'Answer']]);
  assert.equal(referenceGroupKey(42, numeric), 'Answer');
});
