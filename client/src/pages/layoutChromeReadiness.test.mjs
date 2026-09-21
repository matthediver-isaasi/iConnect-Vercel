import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Layout.jsx', import.meta.url), 'utf8');
const publicBranch = source.slice(source.indexOf('// Render public layout for truly public pages'));

test('chrome readiness never replaces or hides the public form parent', () => {
  assert.doesNotMatch(source, /if \(!chromeReady\)\s*\{\s*return/);
  assert.match(publicBranch, /const publicVisibility = \{\}/);
  for (const layout of ['BarePublicLayout', 'PublicLayout']) {
    assert.match(publicBranch, new RegExp(
      `<div style=\\{publicVisibility\\}>\\s*<PortalReadiness[^>]*>\\s*<${layout}[^>]*>\\s*\\{children\\}`,
    ));
  }
  assert.doesNotMatch(publicBranch, /visibility: chromeReady \? 'visible' : 'hidden'/);
});

test('page-owned routes mount their stable public shell while visibility settings load', () => {
  assert.match(source, /if \(!visibilitySettingsFetched && !pageOwned\)/);
});

test('every inbox popup is explicitly gated because portaled dialogs escape root visibility', () => {
  assert.doesNotMatch(publicBranch, /\{inboxUnreadPopupElement\}/);
  assert.equal(
     publicBranch.match(/\{chromeReady && !forceBlankLayout \? inboxUnreadPopupElement : null\}/g)?.length,
    2,
  );
  assert.match(publicBranch, /chromeReady && authResolved && sessionValidated && roleStatus === 'ready' && !forceBlankLayout \? inboxUnreadPopupElement : null/);
});

test('session commits independently of visibility and redirects wait for metadata', () => {
  const effect = source.slice(source.indexOf('const sessionRequest = acquireViewerSessionRequest'), source.indexOf('// Update last_activity'));
  assert.match(effect, /\[authRevision, viewerSessionScope\]/);
  assert.doesNotMatch(effect, /\[location.pathname, authRevision, viewerSessionScope\]/);
  assert.doesNotMatch(effect, /if \(!visibilitySettingsFetched\)/);
  assert.match(effect, /!visibilitySettingsFetched \|\| visibilitySettingsError/);
  assert.doesNotMatch(source, /if \(!hasLocalAuth\)/);
  assert.match(source, /ready=\{!visibilitySettingsError && authResolved && sessionValidated\}/);
  assert.match(source, /hidden=\{!chromeReady \|\| roleStatus !== 'ready'\}/);
  assert.match(source, /\(pageOwned && !chromeReady\)[\s\S]*authResolved && sessionValidated && roleStatus === 'ready'/);
  assert.doesNotMatch(source, /error=\{visibilitySettingsError \|\| sessionError \|\| \(roleStatus/);
});