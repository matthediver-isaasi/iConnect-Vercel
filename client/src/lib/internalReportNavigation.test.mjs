import test from 'node:test';
import assert from 'node:assert/strict';
import { internalReportDestination, canDiscoverInternalReport, getInternalReportMenuDestinations, canAccessReportAwareMenuItem } from './internalReportNavigation.js';
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

test('portal destinations use the read-only route and distinct report permission metadata', () => {
  assert.deepEqual(getInternalReportMenuDestinations([
    { object_id: object, report_id: 'r_saved', name: 'Workforce', object_name: 'Departments' },
    { object_id: 'invalid', report_id: 'r_saved', name: 'Invalid' },
    { object_id: object, report_id: 'r_saved/extra', name: 'Invalid' },
    { object_id: object, report_id: 'r_missing_name' },
  ], origin), [{
    value: url, label: 'Internal report: Workforce · Departments',
    featureId: `internal-report:${object}:r_saved:view`,
  }]);
});

test('report View access alone controls portal items, never Data Studio or a borrowed feature', () => {
  const checks = [];
  const access = { origin, ready: true, allowed, isFeatureExcluded: feature => {
    checks.push(feature);
    return feature === 'admin.data-studio';
  } };
  assert.equal(canAccessReportAwareMenuItem({ url, featureId: 'admin.data-studio' }, access), true);
  assert.deepEqual(checks, []);
  assert.equal(canAccessReportAwareMenuItem({ url, featureId: 'events.view' }, { ...access, allowed: new Set() }), false);
  assert.equal(canAccessReportAwareMenuItem({ url, featureId: 'events.view' }, { ...access, ready: false }), false);
  assert.equal(canAccessReportAwareMenuItem({ url, isExternal: true }, access), false);
  assert.equal(canAccessReportAwareMenuItem({ url: '/internal-reports/invalid/r_saved' }, access), false);
  assert.equal(canAccessReportAwareMenuItem({ url: 'https://outside.test' + url }, access), false);
  assert.equal(canAccessReportAwareMenuItem({ url: '/CustomObjectsAdmin', featureId: 'admin.data-studio' }, access), false);
  assert.equal(canAccessReportAwareMenuItem({ url: '/Events', featureId: 'events.view' }, access), true);
  assert.equal(canAccessReportAwareMenuItem({ title: 'Parent', featureId: 'admin.data-studio' }, access), false);
});
