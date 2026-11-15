import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSalesPortalPermission } from './salesNavigation.js';
import { isResourceExcluded, setDbRoleAccessOverlay } from './roleVisibility';

// Sanitized fixture of the saved GSF row and relevant exclusion. No session
// impersonation or live requests: this exercises Layout's permission resolution.
const menu = { url: 'Dashboard', feature_id: 'system.dashboard' };
const visible = (role: string[], member: string[] = []) => {
  const excluded = (key: string) => isResourceExcluded([...role, ...member], key);
  return !excluded(getSalesPortalPermission(menu.url, excluded) || menu.feature_id);
};

test('portal Dashboard remains visible with Sales excluded; genuine restrictions still apply', () => {
  setDbRoleAccessOverlay([
    { id: 'system', item_key: 'system', item_type: 'module' },
    { id: 'dashboard', item_key: 'system.dashboard', item_type: 'page', parent_id: 'system' },
  ]);
  try {
    assert.equal(visible(['sales']), true);
    assert.equal(visible(['system.dashboard']), false);
    assert.equal(visible([], ['system.dashboard']), false);
    assert.equal(visible(['system']), false);
    assert.equal(visible([], ['system']), false);
    assert.equal(visible(['page_Dashboard']), false);
    // Re-evaluate after edits; no cached decision or blanket admin bypass.
    assert.equal(visible(['system.dashboard']), false);
    assert.equal(visible([]), true);
    assert.equal(visible([], ['system.dashboard']), false);
  } finally {
    setDbRoleAccessOverlay([]);
  }
});

test('desktop and mobile retain shared filtering and GSF keeps MemberDemo landing', () => {
  const layout = readFileSync(new URL('../pages/Layout.jsx', import.meta.url), 'utf8');
  assert.equal((layout.match(/filteredNavigationItems\.map\(/g) || []).length, 2);
  assert.match(layout, /item\.is_active && item\.section === section/);
  assert.match(layout, /items\.filter\(item => !item\.parent_id\)/);
  assert.match(layout, /filteredSubItems\.length > 0 && !isFeatureExcluded\(item\.featureId\)/);
  const login = readFileSync(new URL('../components/auth/LoginForm.jsx', import.meta.url), 'utf8');
  assert.match(login, /slug\.toLowerCase\(\) === 'gsf'\) \{\s*landingPage = 'MemberDemo';/);
});
