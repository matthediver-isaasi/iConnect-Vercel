import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildOrganisationDirectoryMembersUrl,
  memberMatchesDirectoryScope,
} from './organisationDirectoryMemberContext.js';

test('standard organisation links stay in the standard directory', () => {
  assert.equal(
    buildOrganisationDirectoryMembersUrl('org 1'),
    '/OrganisationDirectory/members/org%201'
  );
});

test('dynamic organisation links stay in their source directory', () => {
  assert.equal(
    buildOrganisationDirectoryMembersUrl('org/1', 'partner directory'),
    '/directory/partner%20directory/members/org%2F1'
  );
});

test('organization and role scope must both match', () => {
  const scope = { organizationId: 'org-a', roleIds: ['partner-contact'] };
  assert.equal(memberMatchesDirectoryScope(
    { organization_id: 'org-a', role_id: 'partner-contact' }, scope
  ), true);
  assert.equal(memberMatchesDirectoryScope(
    { organization_id: 'org-b', role_id: 'partner-contact' }, scope
  ), false);
  assert.equal(memberMatchesDirectoryScope(
    { organization_id: 'org-a', role_id: 'ordinary-member' }, scope
  ), false);
});

test('the nested standard route inherits Organisation Directory layout access', () => {
  const routerSource = fs.readFileSync(new URL('../pages/index.jsx', import.meta.url), 'utf8');
  assert.match(
    routerSource,
    /urlParts\[0\]\?\.toLowerCase\(\) === 'organisationdirectory'[\s\S]*return 'OrganisationDirectory'/
  );
});