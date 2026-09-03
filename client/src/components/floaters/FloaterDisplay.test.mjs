import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'FloaterDisplay.jsx'), 'utf8');
const publicLayoutSource = readFileSync(path.join(here, '../layouts/PublicLayout.jsx'), 'utf8');
const portalLayoutSource = readFileSync(path.join(here, '../../pages/Layout.jsx'), 'utf8');

test('floater form submissions use the public client submission contract', () => {
  assert.match(source, /return publicClient\.submitForm\(\{/);
  assert.match(source, /form_id: formId/);
  assert.match(source, /form_name: formName/);
  assert.match(source, /submission_data: data/);
  assert.doesNotMatch(source, /\.from\("form_submission"\)\s*\.insert/);
});

test('floater visibility receives responsive and validated-session state', () => {
  assert.match(source, /const isMobile = useIsMobile\(\)/);
  assert.match(source, /resolveDisplayedFloaters\(\{[\s\S]*isMobile,[\s\S]*authResolved,[\s\S]*sessionValidated,/);
});

test('public and portal render surfaces pass validated-session state to floaters', () => {
  for (const layoutSource of [publicLayoutSource, portalLayoutSource]) {
    assert.match(layoutSource, /<FloaterDisplay[\s\S]*?authResolved=\{authResolved\}[\s\S]*?sessionValidated=\{sessionValidated\}/);
  }
  assert.match(publicLayoutSource, /memberInfo=\{memberInfo\}/);
});

test('public routes validate the server session before resolving floater audience', () => {
  assert.doesNotMatch(portalLayoutSource, /if \(visibility === 'public'\) \{\s*setAuthResolved\(true\);\s*return;/);
  assert.match(portalLayoutSource, /setAuthResolved\(false\);\s*setSessionValidated\(false\);/);
  assert.match(portalLayoutSource, /fetch\('\/api\/auth\/me'/);
  assert.match(portalLayoutSource, /visibility !== 'hybrid' && visibility !== 'public'/);
});
