#!/usr/bin/env node

/**
 * #463 regression test for dash-tolerant comparison + outbound
 * canonicalisation. Plain Node assert — there is no test runner wired up
 * in this project, so this script is invoked manually:
 *
 *   node scripts/test-dash-normalization.mjs
 *
 * Exits non-zero on first failure. Imports the live module so any
 * accidental change to `valuesMatchForMerge`, `applyMappingValueOutbound`,
 * `applyValueMap`, or the dash helpers will trip a test here.
 */

import assert from 'node:assert/strict';

// Stub Supabase before importing the module under test — the helpers we
// exercise here never touch the DB, but the module imports the supabase
// singleton at top level and `database.js` throws if SUPABASE_URL is unset.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'stub';

const mod = await import('../api/_lib/zohoCrmSync.js');
const {
  valuesMatchForMerge,
  normalizeDashesForCompare,
  normalizeDashesToEnDash
} = mod;

const HYPHEN = '\u002D';
const EN_DASH = '\u2013';
const EM_DASH = '\u2014';
const ICONNECT = `Member ${HYPHEN} Education Support Organisations`;
const ZOHO_EN = `Member ${EN_DASH} Education Support Organisations`;
const ZOHO_EM = `Member ${EM_DASH} Education Support Organisations`;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    failed++;
  }
}

console.log('\n=== #463 dash normalisation regression ===\n');

test('normalizeDashesForCompare collapses every dash variant to plain hyphen', () => {
  assert.equal(normalizeDashesForCompare(ICONNECT), ICONNECT);
  assert.equal(normalizeDashesForCompare(ZOHO_EN), ICONNECT);
  assert.equal(normalizeDashesForCompare(ZOHO_EM), ICONNECT);
});

test('normalizeDashesForCompare passes through non-strings unchanged', () => {
  assert.equal(normalizeDashesForCompare(null), null);
  assert.equal(normalizeDashesForCompare(undefined), undefined);
  assert.equal(normalizeDashesForCompare(42), 42);
});

test('normalizeDashesForCompare leaves dash-free strings untouched', () => {
  assert.equal(normalizeDashesForCompare('No dashes here'), 'No dashes here');
  assert.equal(normalizeDashesForCompare(''), '');
});

test('normalizeDashesToEnDash rewrites hyphen and em-dash to en-dash', () => {
  assert.equal(normalizeDashesToEnDash(ICONNECT), ZOHO_EN);
  assert.equal(normalizeDashesToEnDash(ZOHO_EM), ZOHO_EN);
  assert.equal(normalizeDashesToEnDash(ZOHO_EN), ZOHO_EN); // idempotent
});

test('valuesMatchForMerge treats hyphen vs en-dash as equal (single-pick)', () => {
  // Plain (non-multi-pick, non-rich-text) mapping — no canonicalisation,
  // so the dash-normalised primitive comparison is the only thing that
  // can rescue this case. This is the original bug.
  const mapping = { iconnect_field: 'account_type', zoho_field: 'Account_Type' };
  assert.equal(valuesMatchForMerge(mapping, ICONNECT, ZOHO_EN), true);
  assert.equal(valuesMatchForMerge(mapping, ICONNECT, ZOHO_EM), true);
  assert.equal(valuesMatchForMerge(mapping, ZOHO_EN, ICONNECT), true);
});

test('valuesMatchForMerge still rejects real semantic differences', () => {
  const mapping = { iconnect_field: 'account_type', zoho_field: 'Account_Type' };
  assert.equal(valuesMatchForMerge(mapping, ICONNECT, 'Member – Schools'), false);
  assert.equal(valuesMatchForMerge(mapping, 'Active', 'Inactive'), false);
});

test('valuesMatchForMerge still treats null/empty as differences', () => {
  const mapping = { iconnect_field: 'account_type', zoho_field: 'Account_Type' };
  assert.equal(valuesMatchForMerge(mapping, ICONNECT, null), false);
  assert.equal(valuesMatchForMerge(mapping, ICONNECT, ''), false);
  assert.equal(valuesMatchForMerge(mapping, null, null), true);
});

test('valuesMatchForMerge: cross-type primitive compare still works (string vs number)', () => {
  const mapping = { iconnect_field: 'rank', zoho_field: 'Rank' };
  assert.equal(valuesMatchForMerge(mapping, '7', 7), true);
  assert.equal(valuesMatchForMerge(mapping, '7', 8), false);
});

test('valuesMatchForMerge dash-tolerates multi-pick element comparison', () => {
  const mapping = {
    iconnect_field: 'tags',
    zoho_field: 'Tags',
    is_multi_pick: true
  };
  // canonicalizeForHash sorts arrays, so identical sets in different
  // order should still compare equal.
  const ic = [`Member ${HYPHEN} A`, `Member ${HYPHEN} B`];
  const zh = [`Member ${EN_DASH} B`, `Member ${EN_DASH} A`];
  assert.equal(valuesMatchForMerge(mapping, ic, zh), true);
});

test('valuesMatchForMerge multi-pick: still rejects different lengths / different members', () => {
  const mapping = { iconnect_field: 'tags', zoho_field: 'Tags', is_multi_pick: true };
  assert.equal(
    valuesMatchForMerge(mapping, [`A`, `B`], [`A`]),
    false,
    'different lengths must mismatch'
  );
  assert.equal(
    valuesMatchForMerge(mapping, [`Member ${HYPHEN} A`], [`Member ${EN_DASH} C`]),
    false,
    'different real value must mismatch even when both contain dashes'
  );
});

console.log(`\n  ${passed} passed, ${failed} failed.\n`);
process.exit(failed === 0 ? 0 : 1);
