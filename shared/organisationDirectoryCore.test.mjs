import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOrganisationCoreValues } from './organisationDirectoryCore.js';
import { canReadOrganisationDirectory, revalidateOrganisationPublication } from '../api/_lib/organisationDirectoryPublication.js';
test('publication is allowlisted, opt-in, inherited and explicitly revocable', () => {
  const org = { website_url: 'example.test', phone: '+44 123', description: '<script>x</script>', invoicing_email: 'private', balance: 12 };
  assert.deepEqual(projectOrganisationCoreValues(org), {});
  assert.deepEqual(projectOrganisationCoreValues(org, { org_website: true }), { website_url: 'example.test' });
  assert.deepEqual(projectOrganisationCoreValues(org, { org_website: true }, { org_website: { back: false }, org_phone: { back: true } }), { phone: '+44 123' });
  assert.deepEqual(projectOrganisationCoreValues({ phone: '  ' }, { org_phone: true }), {});
});
test('public directory role and tenant boundaries fail closed', () => {
  assert.equal(canReadOrganisationDirectory({ allowed_role_ids: [] }, {}, 'one'), true);
  assert.equal(canReadOrganisationDirectory({ allowed_role_ids: ['role'] }, {}, 'one'), false);
  assert.equal(canReadOrganisationDirectory({ allowed_role_ids: ['role'] }, { tenantId: 'one', isAuthenticated: true, roleId: 'role' }, 'one'), true);
  assert.equal(canReadOrganisationDirectory({ allowed_role_ids: [] }, { tenantId: 'two' }, 'one'), false);
  assert.equal(canReadOrganisationDirectory({ allowed_role_ids: '{}' }, {}, 'one'), false);
});

test('dynamic publication revalidation rejects revocation and role changes before returning values', async () => {
  const directory = { id: 'dir', is_active: true, allowed_role_ids: [], core_field_visibility: null };
  const settings = { corePublication: { org_website: true } };
  let current = { ...directory };
  let publication = { org_website: true };
  const db = {
    from(table) {
      const query = {
        select() { return this; }, eq() { return this; }, limit() { return this; }, like() { return this; },
        then(resolve) {
          return Promise.resolve({ error: null, data: table === 'dynamic_directory' ? [current] : [
            { setting_key: 'org_directory_core_publication', setting_value: JSON.stringify(publication) },
          ] }).then(resolve);
        },
      };
      return query;
    },
  };
  const check = () => revalidateOrganisationPublication({ db, tenantId: 'one', directory, settings, context: {} });
  assert.equal(await check(), true);
  publication = {};
  assert.equal(await check(), false);
  publication = { org_website: true };
  current = { ...directory, allowed_role_ids: ['restricted'] };
  assert.equal(await check(), false);
});
