import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildOrganisationMembersResponse } from '../_lib/directoryConfig.js';

const source = fs.readFileSync(new URL('./members.js', import.meta.url), 'utf8');

test('organisation member scope is server derived and fail closed', () => {
  assert.match(source, /resolveOrgViewMembersRoleIds\(supabase, tenantId, directory\)/);
  assert.match(source, /organization_id', organizationId\)\.in\('role_id', viewMembersRoleIds\)/);
  assert.match(source, /viewMembersRoleIds\.length === 0/);
  assert.doesNotMatch(source, /org_directory_reverse_card_role_ids/);
  assert.doesNotMatch(source, /req\.query\.(role|role_id|role_ids)/);
});

test('organisation and directory access are tenant scoped', () => {
  assert.match(source, /\.eq\('tenant_id', tenantId\)[\s\S]*\.eq\('slug', slug\)/);
  assert.match(source, /\.eq\('tenant_id', tenantId\)[\s\S]*\.eq\('id', organizationId\)/);
  assert.match(source, /membership\.organisation-directory/);
  assert.match(source, /allowedRoles\.includes\(tenantContext\.roleId\)/);
  assert.match(source, /org_directory_allowed_application_statuses/);
  assert.match(source, /org_directory_visible_org_types/);
});

test('organisation-scoped requests require authentication', () => {
  assert.match(source, /organizationId && !tenantContext\.isAuthenticated/);
  assert.match(source, /isStandardOrgDirectory && !organizationId/);
});

test('empty scoped responses retain organisation card metadata', () => {
  const response = buildOrganisationMembersResponse({
    organization: { id: 'org-a', name: 'Organisation A' },
    roles: [{ id: 'contact' }],
    displaySettings: { show_job_title: true },
  });
  assert.deepEqual(response.members, []);
  assert.equal(response.total, 0);
  assert.equal(response.organization.name, 'Organisation A');
  assert.equal(response.roles[0].id, 'contact');
  assert.equal(response.displaySettings.show_job_title, true);
});