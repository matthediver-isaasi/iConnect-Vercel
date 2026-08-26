import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./meetings.js', import.meta.url), 'utf8');

test('Teams meetings endpoint uses canonical tenant admin authorization', () => {
  assert.match(source, /import\s+\{\s*getTenantContext,\s*hasAdminAccess\s*\}\s+from\s+'\.\.\/_lib\/tenantContext\.js'/);
  assert.match(source, /const tenantContext = await getTenantContext\(req\)/);
  assert.match(source, /await hasAdminAccess\(tenantContext\)/);
  assert.match(source, /Admin access required/);
});

test('Teams meetings loads only the caller connection within canonical tenant scope', () => {
  assert.match(source, /session\.tenantId !== tenantContext\.tenantId/);
  assert.match(source, /\.eq\('tenant_id', tenantContext\.tenantId\)\.eq\('identity_id', identityId\)/);
});