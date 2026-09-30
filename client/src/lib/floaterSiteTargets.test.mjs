import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFloaterSiteTargets,
  filterFloatersForPublicSite,
  isFloaterEligibleForViewer,
  isFloaterVisibleOnPublicSite,
  resolveDisplayedFloaters,
  selectedFloaterTargetIds,
  serializeFloaterSiteTargets,
} from './floaterSiteTargets.js';

const MAIN = null;
const MICROSITE_A = '7e5f30c1-6b0f-43ca-8f7d-2d39de25c001';
const MICROSITE_B = '2b6f8f30-1fc5-4ebd-b151-1d6cf5c0e002';

test('legacy floaters with no site targets remain visible everywhere', () => {
  assert.equal(isFloaterVisibleOnPublicSite({ site_targets: null }, MAIN), true);
  assert.equal(isFloaterVisibleOnPublicSite({}, MICROSITE_A), true);
});

test('main-site-only floaters do not render on a microsite', () => {
  const floater = { site_targets: { main_site: true, microsite_ids: [] } };
  assert.equal(isFloaterVisibleOnPublicSite(floater, MAIN), true);
  assert.equal(isFloaterVisibleOnPublicSite(floater, MICROSITE_A), false);
});

test('microsite-only floaters do not render on the main site or another microsite', () => {
  const floater = { site_targets: { main_site: false, microsite_ids: [MICROSITE_A] } };
  assert.equal(isFloaterVisibleOnPublicSite(floater, MAIN), false);
  assert.equal(isFloaterVisibleOnPublicSite(floater, MICROSITE_A), true);
  assert.equal(isFloaterVisibleOnPublicSite(floater, MICROSITE_B), false);
});

test('combined targets render on the main site and every selected microsite', () => {
  const floater = { site_targets: { main_site: true, microsite_ids: [MICROSITE_A] } };
  assert.equal(isFloaterVisibleOnPublicSite(floater, MAIN), true);
  assert.equal(isFloaterVisibleOnPublicSite(floater, MICROSITE_A), true);
  assert.equal(isFloaterVisibleOnPublicSite(floater, MICROSITE_B), false);
  assert.deepEqual(
    filterFloatersForPublicSite([floater, { site_targets: null }], MICROSITE_A),
    [floater, { site_targets: null }],
  );
});

test('new floater selections persist main-site and microsite targets', () => {
  assert.deepEqual(
    buildFloaterSiteTargets(['main-site', MICROSITE_A, MICROSITE_A]),
    { main_site: true, microsite_ids: [MICROSITE_A] },
  );
  assert.deepEqual(
    selectedFloaterTargetIds(null, [{ id: MICROSITE_A }, { id: MICROSITE_B }]),
    ['main-site', MICROSITE_A, MICROSITE_B],
  );
});

test('editing legacy content preserves NULL all-sites targeting until targets change', () => {
  assert.equal(
    serializeFloaterSiteTargets(['main-site', MICROSITE_A], true),
    null,
  );
  assert.deepEqual(
    serializeFloaterSiteTargets(['main-site', MICROSITE_A], false),
    { main_site: true, microsite_ids: [MICROSITE_A] },
  );
});

test('public floaters wait for site resolution while portal floaters remain unchanged', () => {
  const rows = [
    { id: 'main', site_targets: { main_site: true, microsite_ids: [] } },
    { id: 'microsite', site_targets: { main_site: false, microsite_ids: [MICROSITE_A] } },
  ];

  assert.deepEqual(resolveDisplayedFloaters({
    floaters: rows,
    location: 'public',
    activeMicrositeId: null,
    publicSiteContextReady: false,
  }), []);

  assert.deepEqual(resolveDisplayedFloaters({
    floaters: rows,
    location: 'portal',
    activeMicrositeId: MICROSITE_B,
    publicSiteContextReady: false,
    authResolved: true,
    sessionValidated: true,
  }), rows);
});

test('legacy targeting values remain visible to authenticated and public viewers on both devices', () => {
  const legacyFloater = {};
  for (const isMobile of [false, true]) {
    assert.equal(isFloaterEligibleForViewer(legacyFloater, {
      isMobile,
      authResolved: true,
      sessionValidated: false,
    }), true);
    assert.equal(isFloaterEligibleForViewer(legacyFloater, {
      isMobile,
      authResolved: true,
      sessionValidated: true,
    }), true);
  }
});

test('device targeting follows the current responsive breakpoint classification', () => {
  const desktop = { device_target: 'desktop' };
  const mobile = { device_target: 'mobile' };
  assert.equal(isFloaterEligibleForViewer(desktop, { authResolved: true, isMobile: false }), true);
  assert.equal(isFloaterEligibleForViewer(desktop, { authResolved: true, isMobile: true }), false);
  assert.equal(isFloaterEligibleForViewer(mobile, { authResolved: true, isMobile: false }), false);
  assert.equal(isFloaterEligibleForViewer(mobile, { authResolved: true, isMobile: true }), true);
});

test('audience targeting uses validated auth and suppresses all floaters while auth is pending', () => {
  const authenticated = { audience_target: 'authenticated' };
  const publicViewer = { audience_target: 'public' };

  assert.equal(isFloaterEligibleForViewer(authenticated, {
    authResolved: false,
    sessionValidated: true,
  }), false);
  assert.equal(isFloaterEligibleForViewer(publicViewer, {
    authResolved: false,
    sessionValidated: false,
  }), false);
  assert.equal(isFloaterEligibleForViewer(authenticated, {
    authResolved: true,
    sessionValidated: true,
  }), true);
  assert.equal(isFloaterEligibleForViewer(publicViewer, {
    authResolved: true,
    sessionValidated: true,
  }), false);
  assert.equal(isFloaterEligibleForViewer(publicViewer, {
    authResolved: true,
    sessionValidated: false,
  }), true);
});

test('public and portal rendering apply the same viewer targeting after site filtering', () => {
  const authenticated = {
    id: 'authenticated',
    audience_target: 'authenticated',
    site_targets: { main_site: true, microsite_ids: [] },
  };
  const publicViewer = {
    id: 'public',
    audience_target: 'public',
    site_targets: { main_site: true, microsite_ids: [] },
  };
  const options = { floaters: [authenticated, publicViewer], authResolved: true, sessionValidated: true };

  assert.deepEqual(resolveDisplayedFloaters({ ...options, location: 'portal' }), [authenticated]);
  assert.deepEqual(resolveDisplayedFloaters({
    ...options,
    location: 'public',
    publicSiteContextReady: true,
  }), [authenticated]);
});