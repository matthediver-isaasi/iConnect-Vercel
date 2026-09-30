/**
 * Back-of-card custom-fields section label resolution.
 *
 * The resolver is intentionally mirrored client and server (like the other
 * directory config helpers); this test exercises both copies with identical
 * cases so they cannot drift apart, plus the public embed payload shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCustomFieldsLabel as serverResolve,
  DEFAULT_CUSTOM_FIELDS_LABEL as serverDefault,
} from './directoryConfig.js';
import {
  resolveCustomFieldsLabel as clientResolve,
  DEFAULT_CUSTOM_FIELDS_LABEL as clientDefault,
} from '../../client/src/utils/directorySettings.js';
import { buildPublicDirectoryPayload } from '../public/dynamic-directory.js';

const IMPLS = [
  ['server (api/_lib/directoryConfig.js)', serverResolve, serverDefault],
  ['client (client/src/utils/directorySettings.js)', clientResolve, clientDefault],
];

for (const [name, resolve, DEFAULT] of IMPLS) {
  test(`${name}: default is "Additional Information"`, () => {
    assert.equal(DEFAULT, 'Additional Information');
    assert.equal(resolve(), DEFAULT);
    assert.equal(resolve(null, undefined), DEFAULT);
  });

  test(`${name}: per-directory override wins over global`, () => {
    assert.equal(resolve('Directory label', 'Global label'), 'Directory label');
  });

  test(`${name}: blank/whitespace override falls back to global`, () => {
    assert.equal(resolve('', 'Global label'), 'Global label');
    assert.equal(resolve('   ', 'Global label'), 'Global label');
    assert.equal(resolve(null, 'Global label'), 'Global label');
  });

  test(`${name}: blank override and blank global fall back to default`, () => {
    assert.equal(resolve('', ''), DEFAULT);
    assert.equal(resolve('  ', null), DEFAULT);
  });

  test(`${name}: labels are trimmed and non-strings ignored`, () => {
    assert.equal(resolve('  Trimmed  '), 'Trimmed');
    assert.equal(resolve(42, { a: 1 }, 'Global'), 'Global');
  });
}

test('server and client resolvers behave identically', () => {
  const cases = [
    [],
    ['Override', 'Global'],
    ['', 'Global'],
    ['   ', ''],
    [null, undefined],
    ['  Padded  ', null],
  ];
  for (const args of cases) {
    assert.equal(serverResolve(...args), clientResolve(...args));
  }
});

test('public embed payload carries trimmed custom_fields_label, blank -> null', () => {
  const base = { id: 'd1', slug: 's', name: 'N', entity_type: 'member' };
  assert.equal(
    buildPublicDirectoryPayload({ ...base, custom_fields_label: '  Extra Info  ' }).custom_fields_label,
    'Extra Info'
  );
  assert.equal(buildPublicDirectoryPayload({ ...base, custom_fields_label: '   ' }).custom_fields_label, null);
  assert.equal(buildPublicDirectoryPayload({ ...base }).custom_fields_label, null);
});
