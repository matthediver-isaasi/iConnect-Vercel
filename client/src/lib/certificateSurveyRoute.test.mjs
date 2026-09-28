import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSurveyRedirect, readCertificateSurveyGrant } from './certificateSurveyRoute.js';

function browser(hash = '') {
  const storage = new Map();
  const location = { pathname: '/survey/fixture', search: '?tenant=fixture', hash };
  return {
    location, storage,
    history: { state: null, replaceState() { location.hash = ''; } },
    sessionStorage: {
      getItem: key => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  };
}

test('captures missing-bootstrap/SPA fragment and survives refresh without consuming it', () => {
  const token = 'a'.repeat(43);
  const b = browser(`#certificate_grant=${token}`);
  assert.equal(readCertificateSurveyGrant(b), token);
  assert.equal(b.location.hash, '');
  assert.equal(readCertificateSurveyGrant(b), token);
});

test('canonical redirect restores only the survey capability in fragment, never canonical URL or query', () => {
  const token = 'b'.repeat(43);
  const b = browser(`#certificate_grant=${token}`);
  readCertificateSurveyGrant(b); // Head bootstrap already removed the fragment.
  const next = canonicalSurveyRedirect('approved.example.org', b);
  assert.equal(next.destination, `${next.canonical}#certificate_grant=${token}`);
  assert.equal(next.canonical, 'https://approved.example.org/survey/fixture?tenant=fixture');
  for (const domain of ['evil.test/path', 'user@evil.test', 'evil.test#x', 'https://evil.test', 'evil.test:443']) {
    assert.equal(canonicalSurveyRedirect(domain, b), null);
  }
});

test('malformed new invitation replaces old credential and fails closed', () => {
  const b = browser('#certificate_grant=bad');
  b.storage.set('certificate-survey:/survey/fixture', 'a'.repeat(43));
  assert.equal(readCertificateSurveyGrant(b), 'invalid');
  assert.equal(readCertificateSurveyGrant(b), 'invalid');
});

test('non-assignment paths never transfer grants; denied storage does not drop a fresh fragment', () => {
  const b = browser(`#certificate_grant=${'c'.repeat(43)}`);
  Object.defineProperty(b, 'sessionStorage', { get() { throw new Error('Storage disabled'); } });
  assert.equal(readCertificateSurveyGrant(b), 'c'.repeat(43));
  b.location.pathname = '/FormView';
  assert.equal(readCertificateSurveyGrant(b), null);
});