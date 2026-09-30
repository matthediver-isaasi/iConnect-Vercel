// Task #3332 regression tests: reporting anonymity must be governed by each
// response's immutable VERSION SNAPSHOT settings — never the mutable live
// form settings — with strictest-protection for mixed-version result sets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSubmissionAnonymous,
  governingThreshold,
  computeSetAnonymity,
} from './surveyReportAnonymity.js';

const V_ANON = { id: 'v-anon', survey_settings: { response_identity: 'anonymous', anonymity_threshold: 5 } };
const V_IDENT = { id: 'v-ident', survey_settings: { response_identity: 'identified' } };
const versionById = new Map([[V_ANON.id, V_ANON], [V_IDENT.id, V_IDENT]]);

const sub = (id, versionId, extra = {}) => ({ id, survey_version_id: versionId, ...extra });

test('historical anonymous version stays anonymous after live form re-published as identified', () => {
  const liveIdentifiedForm = { survey_settings: { response_identity: 'identified' } };
  assert.equal(isSubmissionAnonymous(sub('s1', 'v-anon'), versionById, liveIdentifiedForm), true);
  assert.equal(governingThreshold(sub('s1', 'v-anon'), versionById, liveIdentifiedForm), 5);
});

test('identified history is NOT suppressed when live form is later made anonymous', () => {
  const liveAnonForm = { survey_settings: { response_identity: 'anonymous', anonymity_threshold: 10 } };
  assert.equal(isSubmissionAnonymous(sub('s1', 'v-ident'), versionById, liveAnonForm), false);
  const set = computeSetAnonymity([sub('s1', 'v-ident'), sub('s2', 'v-ident')], versionById, liveAnonForm);
  assert.equal(set.isAnonymous, false);
  assert.equal(set.suppressAnonymousRows, false);
  assert.equal(set.allSuppressed, false);
});

test('submission-level is_anonymous flag is honoured even under an identified version', () => {
  const form = { survey_settings: {} };
  assert.equal(isSubmissionAnonymous(sub('s1', 'v-ident', { is_anonymous: true }), versionById, form), true);
});

test('below-threshold anonymous set is fully suppressed', () => {
  const form = { survey_settings: {} };
  const subs = [sub('s1', 'v-anon'), sub('s2', 'v-anon')]; // threshold 5
  const set = computeSetAnonymity(subs, versionById, form);
  assert.equal(set.isAnonymous, true);
  assert.equal(set.threshold, 5);
  assert.equal(set.suppressAnonymousRows, true);
  assert.equal(set.allSuppressed, true);
});

test('at-threshold anonymous set is not suppressed', () => {
  const form = { survey_settings: {} };
  const subs = ['a', 'b', 'c', 'd', 'e'].map((id) => sub(id, 'v-anon'));
  const set = computeSetAnonymity(subs, versionById, form);
  assert.equal(set.suppressAnonymousRows, false);
  assert.equal(set.allSuppressed, false);
});

test('mixed-version set: strictest protection wins, per-row predicate redacts only anonymous rows', () => {
  const form = { survey_settings: {} };
  const anon1 = sub('a1', 'v-anon');
  const ident1 = sub('i1', 'v-ident');
  const ident2 = sub('i2', 'v-ident');
  const set = computeSetAnonymity([anon1, ident1, ident2], versionById, form);
  assert.equal(set.isAnonymous, true);
  assert.equal(set.anonCount, 1);
  // 1 anonymous row < threshold 5: anonymous rows withheld, identified kept.
  assert.equal(set.suppressAnonymousRows, true);
  assert.equal(set.allSuppressed, false);
  assert.equal(set.isAnonymousRow(anon1), true);
  assert.equal(set.isAnonymousRow(ident1), false);
});

test('missing snapshot falls back to live form settings', () => {
  const form = { survey_settings: { response_identity: 'anonymous', anonymity_threshold: 4 } };
  const orphan = sub('o1', 'v-gone');
  assert.equal(isSubmissionAnonymous(orphan, versionById, form), true);
  assert.equal(governingThreshold(orphan, versionById, form), 4);
});
