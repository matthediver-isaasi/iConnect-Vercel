import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const layout = readFileSync(new URL('../pages/Layout.jsx', import.meta.url), 'utf8');
const effect = layout.slice(
  layout.indexOf('  // Check if current page is excluded and redirect if needed'),
  layout.indexOf('  // Save sidebar scroll position to sessionStorage'),
);

function render(overrides = {}) {
  const redirects = [];
  let dependencies;
  const state = {
    currentPageName: 'NMCMembershipReport',
    tenantBranding: { loading: false },
    authResolved: true, sessionValidated: true, roleStatus: 'ready',
    memberInfo: { id: 'member' }, memberRole: { default_landing_page: 'Preferences' },
    isPublicPage: () => false, pageToFeatureIdMap: { NMCMembershipReport: 'membership.nmc-membership-report' },
    migrateLegacyFeatureId: id => id,
    groupAssignmentsFetched: true, isCurrentMemberGroupAdmin: false,
    viewableCustomObjectsFetched: true, viewableCustomObjectIds: new Set(),
    getCustomObjectIdFromPortalPath: () => null,
    location: { pathname: '/NMCMembershipReport' },
    createPageUrl: name => `/${name}`,
    ...overrides,
  };
  // Mirror the fail-closed feature result during pending authority. A redirect
  // must wait; do not change that result to "allowed" to fix the timing bug.
  state.isFeatureExcluded = () => Boolean(state.tenantBranding.loading || !state.sessionValidated
    || state.roleStatus !== 'ready' || state.denied);
  state.isCurrentPageExcluded = state.isFeatureExcluded;
  state.window = { location: { set href(value) { redirects.push(value); } } };
  state.useEffect = (callback, deps) => { dependencies = deps; callback(); };
  vm.runInNewContext(effect, state);
  return { redirects, dependencies };
}

test('NMC redirect waits for branding and session authority instead of bouncing a cached member', () => {
  assert.deepEqual(render({ tenantBranding: { loading: true } }).redirects, []);
  assert.deepEqual(render({ authResolved: false, sessionValidated: false }).redirects, []);
  assert.deepEqual(render({ roleStatus: 'loading' }).redirects, []);
  assert.deepEqual(render().redirects, []);
});

test('settled denials still redirect; pending denial is re-evaluated when dependencies settle', () => {
  const pending = render({ tenantBranding: { loading: true }, denied: true });
  const denied = render({ denied: true });
  assert.deepEqual(pending.redirects, []);
  assert.deepEqual(denied.redirects, ['/Preferences']);
  assert.notDeepEqual(pending.dependencies, denied.dependencies);
  for (const state of [
    { authResolved: false, sessionValidated: false },
    { roleStatus: 'loading' },
  ]) {
    assert.notDeepEqual(render(state).dependencies, render().dependencies);
  }
  assert.deepEqual(render({ sessionValidated: false }).redirects, ['/Preferences']);
});

test('other pages and fallback-loop prevention keep their existing behaviour', () => {
  assert.deepEqual(render({ currentPageName: 'OtherReport', denied: true, tenantBranding: { loading: true } }).redirects, ['/Preferences']);
  assert.deepEqual(render({ currentPageName: 'Preferences', denied: true }).redirects, []);
});
