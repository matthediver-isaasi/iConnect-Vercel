import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendInternalQuery,
  normalizeInternalReturnTo,
} from './safeReturnTo.js';

test('returnTo accepts internal path, query, and hash', () => {
  assert.equal(
    normalizeInternalReturnTo('/events?next=%2Fmember#tickets'),
    '/events?next=%2Fmember#tickets'
  );
});

test('returnTo rejects absolute, protocol-relative, backslash, and control inputs', () => {
  for (const value of [
    'https://evil.example/phish',
    '//evil.example/phish',
    '/\\\\evil.example',
    '/events%0d%0aLocation:%20https://evil.example',
    '/events\u0000',
  ]) {
    assert.equal(normalizeInternalReturnTo(value, '/safe'), '/safe', value);
  }
});

test('OAuth callback query appending preserves an existing query and hash', () => {
  assert.equal(
    appendInternalQuery('/settings?tab=outlook#connections', 'outlook_connected', 'true'),
    '/settings?tab=outlook&outlook_connected=true#connections'
  );
});
