import test from 'node:test';
import assert from 'node:assert/strict';
import { setMemberContentCacheHeaders } from './canvasMemberOnly.js';

function responseMock(initialVary = '') {
  const headers = new Map(initialVary ? [['Vary', initialVary]] : []);
  return {
    setHeader(name, value) {
      headers.set(name, value);
    },
    getHeader(name) {
      return headers.get(name);
    },
    header(name) {
      return headers.get(name);
    },
  };
}

test('member-content cache headers are private and vary by session credentials', () => {
  const res = responseMock();
  setMemberContentCacheHeaders(res, { includeHost: true });
  assert.equal(
    res.getHeader('Cache-Control'),
    'private, no-store, must-revalidate'
  );
  assert.equal(
    res.getHeader('Vary'),
    'Cookie, Authorization, Host'
  );
});

test('cache helper preserves existing host variation without duplicates', () => {
  const res = responseMock('Host, X-Forwarded-Host');
  setMemberContentCacheHeaders(res, { includeHost: true });
  assert.equal(
    res.getHeader('Vary'),
    'Host, X-Forwarded-Host, Cookie, Authorization'
  );
});
