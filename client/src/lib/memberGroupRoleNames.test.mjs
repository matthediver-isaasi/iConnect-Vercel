// Focused tests for member group role name standardisation helpers,
// especially metadata preservation when case-only duplicate roles merge.
// Run: node --test client/src/lib/memberGroupRoleNames.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roleNameKey,
  toTitleCase,
  canonicalizeRoleName,
  remapRoleKeyedMap,
  isEmptyRoleHtml,
  isEmptyRoleUrl,
  isEmptyRoleTermDef,
} from './memberGroupRoleNames.js';

test('toTitleCase capitalises words and preserves acronyms', () => {
  assert.equal(toTitleCase('vice chair'), 'Vice Chair');
  assert.equal(toTitleCase('PR officer'), 'PR Officer');
  assert.equal(toTitleCase('  leadership   team  member '), 'Leadership Team Member');
});

test('canonicalizeRoleName reuses existing spelling case-insensitively', () => {
  assert.equal(canonicalizeRoleName('CHAIR', ['Chair', 'Member']), 'Chair');
  assert.equal(canonicalizeRoleName('treasurer', []), 'Treasurer');
  assert.equal(canonicalizeRoleName('', ['Chair']), '');
});

test('emptiness predicates', () => {
  assert.equal(isEmptyRoleHtml('<p>&nbsp;</p>'), true);
  assert.equal(isEmptyRoleHtml('<p>Terms</p>'), false);
  assert.equal(isEmptyRoleUrl('  '), true);
  assert.equal(isEmptyRoleUrl('https://x.test'), false);
  assert.equal(isEmptyRoleTermDef(null), true);
  assert.equal(isEmptyRoleTermDef({ term_value: 0, max_terms: null }), true);
  assert.equal(isEmptyRoleTermDef({ term_value: 2, term_unit: 'years' }), false);
  assert.equal(isEmptyRoleTermDef({ max_terms: 3 }), false);
});

const canon = new Map([[roleNameKey('chair'), 'Chair']]);

test('remapRoleKeyedMap: non-empty entry beats empty on case-only merge (either order)', () => {
  const preferred = new Map([[roleNameKey('chair'), 'chair']]);
  // Empty first, non-empty second.
  let out = remapRoleKeyedMap(
    { chair: '', Chair: '<p>Terms</p>' },
    canon, preferred, isEmptyRoleHtml
  );
  assert.deepEqual(out, { Chair: '<p>Terms</p>' });
  // Non-empty first, empty second — even when the empty key is the preferred variant.
  out = remapRoleKeyedMap(
    { Chair: '<p>Terms</p>', chair: '' },
    canon, preferred, isEmptyRoleHtml
  );
  assert.deepEqual(out, { Chair: '<p>Terms</p>' });
});

test('remapRoleKeyedMap: preferred variant wins among non-empty entries', () => {
  const preferred = new Map([[roleNameKey('chair'), 'CHAIR']]);
  const out = remapRoleKeyedMap(
    { chair: 'https://a.test', CHAIR: 'https://b.test' },
    canon, preferred, isEmptyRoleUrl
  );
  assert.deepEqual(out, { Chair: 'https://b.test' });
});

test('remapRoleKeyedMap: first-seen wins when no preferred variant applies', () => {
  const out = remapRoleKeyedMap(
    { chair: 'https://a.test', 'CHAIR ': 'https://b.test' },
    canon, new Map(), isEmptyRoleUrl
  );
  assert.deepEqual(out, { Chair: 'https://a.test' });
});

test('remapRoleKeyedMap: term definitions with data survive merge with empty def', () => {
  const preferred = new Map([[roleNameKey('chair'), 'chair']]);
  const out = remapRoleKeyedMap(
    { chair: { term_value: null, max_terms: null }, Chair: { term_value: 2, term_unit: 'years' } },
    canon, preferred, isEmptyRoleTermDef
  );
  assert.deepEqual(out, { Chair: { term_value: 2, term_unit: 'years' } });
});

test('remapRoleKeyedMap: unmapped keys kept as-is', () => {
  const out = remapRoleKeyedMap({ Secretary: 'https://s.test' }, canon, new Map(), isEmptyRoleUrl);
  assert.deepEqual(out, { Secretary: 'https://s.test' });
});
