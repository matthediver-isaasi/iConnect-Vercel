import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(
  join(__dirname, '..', 'pages', 'EmailTemplateManagement.jsx'),
  'utf8',
);
const clientSource = readFileSync(
  join(__dirname, '..', 'api', 'base44Client.js'),
  'utf8',
);

test('an unconfigured tenant starts and resolves to an empty footer', () => {
  assert.match(pageSource, /useState\(''\)/);
  assert.match(pageSource, /setFooterHtml\(footerSetting\?\.setting_value \?\? ''\)/);
  assert.doesNotMatch(pageSource, /DEFAULT_EMAIL_FOOTER/);
  assert.doesNotMatch(pageSource, /Graduate Futures Institute/);
  assert.doesNotMatch(pageSource, /graduatefutures\.org/);
});

test('a configured tenant still loads its saved footer', () => {
  assert.match(pageSource, /footerSetting\?\.setting_value \?\? ''/);
  assert.match(pageSource, /SystemSettings\.update\(footerSetting\.id/);
  assert.match(pageSource, /SystemSettings\.create\(\{\s*setting_key: 'email_footer_html'/);
});

test('footer state and query cache reset when the active tenant changes', () => {
  assert.match(pageSource, /queryKey: \['email-footer-setting', activeTenantId\]/);
  assert.match(pageSource, /useEffect\(\(\) => \{\s*setFooterHtml\(''\);\s*\}, \[activeTenantId\]\)/);
  assert.match(pageSource, /subscribeToActiveTenantId\(setActiveTenantIdState\)/);
  assert.match(clientSource, /_activeTenantListeners\.forEach\(listener => listener\(_activeTenantId\)\)/);
});