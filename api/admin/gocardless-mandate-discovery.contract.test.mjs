import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('admin discovery endpoint enforces auth/admin checks and passes only context tenant to service', async () => {
  const source = await readFile(new URL('./gocardless-mandate-discovery.js', import.meta.url), 'utf8');
  assert.match(source, /getTenantContext\(req\)/);
  assert.match(source, /!context\?\.isAuthenticated/);
  assert.match(source, /hasAdminAccess\(context\)/);
  assert.match(source, /const tenantId = context\.tenantId/);
  assert.match(source, /runMandateDiscovery\(\{[\s\S]*db: supabase, tenantId/);
  assert.doesNotMatch(source, /req\.(body|query)\.tenant/);
});