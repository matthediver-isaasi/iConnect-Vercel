import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Layout.jsx', import.meta.url), 'utf8');
const publicBranch = source.slice(source.indexOf('// Render public layout for truly public pages'));

test('chrome readiness changes visibility rather than replacing the form parent', () => {
  assert.doesNotMatch(source, /if \(!chromeReady\)\s*\{\s*return/);
  assert.match(publicBranch, /const publicVisibility = \{ visibility: chromeReady \? 'visible' : 'hidden' \}/);
  for (const layout of ['BarePublicLayout', 'PublicLayout']) {
    assert.match(publicBranch, new RegExp(
      `<div style=\\{publicVisibility\\}>\\s*<${layout}[^>]*>\\s*\\{children\\}`,
    ));
  }
  assert.match(publicBranch, /fontFamily: portalRootFont,[\s\S]*?visibility: chromeReady \? 'visible' : 'hidden'/);
});

test('every inbox popup is explicitly gated because portaled dialogs escape root visibility', () => {
  assert.doesNotMatch(publicBranch, /\{inboxUnreadPopupElement\}/);
  assert.equal(
    publicBranch.match(/\{chromeReady \? inboxUnreadPopupElement : null\}/g)?.length,
    3,
  );
});