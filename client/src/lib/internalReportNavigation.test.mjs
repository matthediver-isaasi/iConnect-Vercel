import test from 'node:test';
import assert from 'node:assert/strict';
import { internalReportDestination, canDiscoverInternalReport } from './internalReportNavigation.js';
const origin = 'https://bnms.example.test';
const object = '11111111-1111-4111-8111-111111111111';
const url = `/internal-reports/${object}/r_saved`;
const allowed = new Set([`${object}:r_saved`]);
test('internal report destinations retain identity through queries and hashes without trusting foreign origins', () => {
  assert.equal(internalReportDestination(`${url}?page=2#report`, origin), `${object}:r_saved`);
  assert.equal(internalReportDestination(origin + url, origin), `${object}:r_saved`);
  for (const value of ['https://outside.test' + url, '/internal-reports/invalid/r_saved', url + '/extra', url + '%2Fextra']) {
    assert.equal(internalReportDestination(value, origin), null);
  }
});
test('navigation hides guessed, stale, external and unresolved report links without hiding unrelated destinations', () => {
  assert.equal(canDiscoverInternalReport({ url }, { origin, ready: true, allowed }), true);
  for (const item of [{ url, isExternal: true }, { url: url + '_other' }, { url: 'https://outside.test' + url }]) {
    assert.equal(canDiscoverInternalReport(item, { origin, ready: true, allowed }), false);
  }
  assert.equal(canDiscoverInternalReport({ url }, { origin, ready: false, allowed }), false);
  assert.equal(canDiscoverInternalReport({ url: '/portal' }, { origin, ready: false, allowed: new Set() }), true);
});
