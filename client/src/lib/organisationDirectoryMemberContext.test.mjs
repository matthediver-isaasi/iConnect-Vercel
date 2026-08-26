import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOrganisationDirectoryMembersUrl,
  hasOrganisationDirectoryOrigin,
  memberMatchesDirectoryScope,
  resolveDirectoryRoleIds,
} from './organisationDirectoryMemberContext.js';

test('organisation links carry the organization and trusted origin marker', () => {
  const url = buildOrganisationDirectoryMembersUrl('org 1');
  assert.equal(url, '/memberdirectory?org=org+1&origin=organisation-directory');
  assert.equal(hasOrganisationDirectoryOrigin(url.split('?')[1]), true);
});

test('organisation origin uses configured contact roles instead of member-directory roles', () => {
  assert.deepEqual(resolveDirectoryRoleIds({
    hasOrganisationOrigin: true,
    organisationRoleIds: ['partner-contact'],
    memberDirectoryRoleIds: ['ordinary-member'],
    availableRoleIds: ['partner-contact', 'ordinary-member'],
  }), ['partner-contact']);
});

test('direct, legacy, and invalid origin URLs retain member-directory role behavior', () => {
  for (const search of ['', '?org=one', '?org=one&origin=untrusted']) {
    assert.equal(hasOrganisationDirectoryOrigin(search), false);
    assert.deepEqual(resolveDirectoryRoleIds({
      hasOrganisationOrigin: hasOrganisationDirectoryOrigin(search),
      organisationRoleIds: ['partner-contact'],
      memberDirectoryRoleIds: ['ordinary-member'],
      availableRoleIds: ['partner-contact', 'ordinary-member'],
    }), ['ordinary-member']);
  }
});

test('empty or stale organisation role settings safely fall back', () => {
  for (const organisationRoleIds of [[], ['deleted-role']]) {
    assert.deepEqual(resolveDirectoryRoleIds({
      hasOrganisationOrigin: true,
      organisationRoleIds,
      memberDirectoryRoleIds: ['ordinary-member'],
      availableRoleIds: ['ordinary-member'],
    }), ['ordinary-member']);
  }
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