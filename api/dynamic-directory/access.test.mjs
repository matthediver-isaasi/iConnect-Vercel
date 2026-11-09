import test from 'node:test';
import assert from 'node:assert/strict';
import config from './config.js';
import members from './members.js';
import preferences from './member-preferences.js';
import { dynamicDirectoryHandler as embed } from '../public/dynamic-directory.js';
import { canReadOrganisationDirectory as allowed } from '../_lib/organisationDirectoryPublication.js';

const directory = { id: 'dir', entity_type: 'member', allowed_role_ids: ['allowed'], is_active: true };
test('directory policy preserves public access and fails closed for restricted or malformed roles', () => {
  const guest = { tenantId: 'tenant', isAuthenticated: false };
  assert.equal(allowed(directory, guest, 'tenant'), false);
  assert.equal(allowed(directory, { ...guest, isAuthenticated: true, roleId: 'wrong' }, 'tenant'), false);
  assert.equal(allowed(directory, { ...guest, isAuthenticated: true, roleId: 'allowed' }, 'tenant'), true);
  assert.equal(allowed(directory, { ...guest, tenantUserId: 'admin' }, 'tenant'), true);
  assert.equal(allowed(directory, { ...guest, tenantId: 'other', tenantUserId: 'admin' }, 'tenant'), false);
  assert.equal(allowed({ allowed_role_ids: [] }, guest, 'tenant'), true);
  assert.equal(allowed({ allowed_role_ids: 'broken' }, guest, 'tenant'), false);
});
for (const [name, handler] of Object.entries({ config, members, preferences, embed })) {
  for (const authenticated of [false, true]) {
    test(`${name} rejects ${authenticated ? 'wrong-role member' : 'guest'} before any directory data read`, async () => {
      const db = { from(table) {
        assert.equal(table, 'dynamic_directory', 'No member, preference or metadata reads before authorization');
        return { select() { return this; }, eq() { return this; }, limit() { return Promise.resolve({ data: [directory] }); } };
      } };
      const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ method: 'GET', query: { slug: 'private', member_ids: 'member' } }, res, {
        supabase: db, getTenantContext: async () => ({ tenantId: 'tenant', isAuthenticated: authenticated, roleId: 'wrong' }),
        resolveTenant: async () => ({ id: 'tenant' }),
      });
      assert.equal(res.code, authenticated ? 403 : 401);
      assert.match(res.body.error, /access denied/);
    });
  }
}
