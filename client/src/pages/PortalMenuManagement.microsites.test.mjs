import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGACY_TO_NEW_MAPPING } from '../../../api/_lib/roleAccessHierarchy.generated.js';

test('Microsite Management is selectable with its existing RBAC permission', () => {
  const source = readFileSync(new URL('./PortalMenuManagement.jsx', import.meta.url), 'utf8');
  assert.match(source, /\{ value: "MicrositeManagement", label: "Microsite Management", featureId: "site-builder\.micro-sites" \}/);
  assert.match(source, /if \(page\?\.featureId\) \{\s*next\.feature_id = page\.featureId;/);
  assert.equal(LEGACY_TO_NEW_MAPPING.page_MicrositeManagement, 'site-builder.micro-sites');
  assert.equal(LEGACY_TO_NEW_MAPPING.page_admin_MicrositeManagement, 'site-builder.micro-sites');
});
