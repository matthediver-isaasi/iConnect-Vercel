import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { migrateLegacyFeatureId } from './roleAccessMap.ts';
import { isResourceExcluded } from './roleVisibility.ts';

test('award application navigation has a member RBAC key and inherits User restrictions', () => {
  assert.equal(migrateLegacyFeatureId('page_AwardApplications'), 'user.my-award-applications');
  assert.equal(migrateLegacyFeatureId('page_user_AwardApplications'), 'user.my-award-applications');
  assert.equal(isResourceExcluded(['user'], 'user.my-award-applications'), true);
  assert.equal(isResourceExcluded(['user.my-award-applications'], 'user.my-award-applications'), true);
  assert.equal(isResourceExcluded([], 'user.my-award-applications'), false);
});

test('portal menu offers the correct route and default permission without automatic injection', () => {
  const menu = readFileSync(new URL('../pages/PortalMenuManagement.jsx', import.meta.url), 'utf8');
  assert.match(menu, /AwardApplications: "user\.my-award-applications"/);
  assert.match(menu, /value: "AwardApplications", label: "My award applications", route: "\/award-applications"/);
  const layout = readFileSync(new URL('../pages/Layout.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(layout, /isAwardApplicantDestination|withApplicantApplications|title: ['"]My award applications/);
});
