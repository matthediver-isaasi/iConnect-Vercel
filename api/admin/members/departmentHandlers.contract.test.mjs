import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseMemberListFilters } from '../../_lib/memberListFilters.js';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const paginated = read('./paginated.js');
const exported = read('./export-csv.js');
const options = read('./departments.js');
const directory = read('../../dynamic-directory/members.js');
const entityById = read('../../entities/[entity]/[id].js');

test('admin list and CSV share departmentId parsing and only apply resolved non-empty IDs', () => {
  const context = parseMemberListFilters({
    organizationId: 'org-a,org-b',
    departmentId: 'dept-a,dept-b',
  });
  assert.deepEqual(context.organizationIds, ['org-a', 'org-b']);
  assert.deepEqual(context.departmentIds, ['dept-a', 'dept-b']);

  for (const source of [paginated, exported]) {
    assert.match(source, /parseMemberListFilters\(\{ search, organizationId, departmentId,/);
    assert.match(source, /resolveDepartmentMemberIds\(supabase, tenantId, filterCtx\.departmentIds\)/);
  }
  assert.match(paginated, /departmentMemberIds && departmentMemberIds\.length === 0/);
  assert.match(paginated, /if \(departmentMemberIds\) query = query\.in\('id', departmentMemberIds\)/);
  assert.match(exported, /hasNoDepartmentMatches/);
  assert.match(exported, /if \(hasNoDepartmentMatches\) q = q\.eq\('id', '00000000-0000-0000-0000-000000000000'\)/);
  assert.match(exported, /if \(departmentMemberIds\) q = q\.in\('id', departmentMemberIds\)/);
  assert.match(exported, /'department_name'/);
  assert.match(exported, /member\.departments \|\| \[\]/);
  assert.match(exported, /\.join\('; '\)/);
  assert.match(exported, /enrichMembersWithDepartments\(supabase, tenantId, pageData\)/);
  assert.match(paginated, /enrichMembersWithDepartments\(supabase, tenantId, memberRows\)/);
});

test('member select-all CSV mirrors every list scope and validates the displayed total', () => {
  const membersList = read('../../../client/src/pages/MembersList.jsx');
  for (const param of [
    'search', 'organizationId', 'departmentId', 'roleId', 'status',
    'customFilters', 'organizationFilters', 'coreFilters',
  ]) {
    assert.match(membersList, new RegExp(`params\\.set\\('${param}'`));
  }
  assert.match(membersList, /body\.drillIds = drillIdsParam/);
  assert.match(membersList, /body\.expectedTotal = pagination\.total/);
  assert.match(membersList, /method: 'POST'/);
  assert.match(exported, /req\.body\?\.drillIds/);
  assert.match(exported, /if \(drillIds\.length > 0\) q = q\.in\('id', drillIds\)/);
  assert.match(exported, /firstPage\.count/);
  assert.match(exported, /memberExportCountError\(expectedTotal, actualTotal\)/);
});

test('member CSV rejects genuine empty and mismatched exports instead of returning headers', () => {
  const firstPageFetch = exported.indexOf('const firstPage = await buildMemberQuery');
  const headers = exported.indexOf("res.setHeader('Content-Type'");
  assert.ok(firstPageFetch >= 0 && headers > firstPageFetch);
  assert.match(exported, /res\.status\(409\)\.json\(\{ error: message, expectedTotal, actualTotal \}\)/);
  assert.match(exported, /shouldRejectEmptyMemberExport\(req\.method, actualTotal\)/);
  assert.match(exported, /res\.status\(422\)\.json\(\{ error: 'There are no members to export/);
  const membersList = read('../../../client/src/pages/MembersList.jsx');
  assert.match(membersList, /await response\.json\(\)\.catch/);
  assert.match(membersList, /detail\?\.error \|\| 'Export failed'/);
});

test('explicit member CSV selection uses a POST body and carries its expected row count', () => {
  const membersList = read('../../../client/src/pages/MembersList.jsx');
  assert.match(membersList, /body\.selectedIds = selectedMembers/);
  assert.match(membersList, /body\.expectedTotal = selectedMembers\.length/);
  assert.match(exported, /req\.body\?\.selectedIds/);
});

test('passive list/export enrichment delegates optional-schema compatibility to helper', () => {
  // `enrichMembersWithDepartments` is intentionally called without a
  // department filter; its tested optional schema contract returns null fields
  // instead of causing legacy tenants to fail.
  assert.match(paginated, /enrichMembersWithDepartments\(supabase, tenantId, memberRows\)/);
  assert.match(exported, /enrichMembersWithDepartments\(supabase, tenantId, pageData\)/);
  assert.match(read('../../_lib/memberDepartments.js'), /if \(!schema\) return members\.map/);
});

test('department options endpoint honors all, validates IDs, and uses admin capability', () => {
  assert.match(options, /getTenantContext, hasAdminAccess/);
  assert.match(options, /await hasAdminAccess\(context\)/);
  assert.match(options, /rawOrganizationId === 'all' \? \[\]/);
  assert.match(options, /organizationIds\.some\(id => !UUID_RE\.test\(id\)\)/);
  assert.match(options, /listDepartmentOptions\(supabase, context\.tenantId, organizationIds\)/);
});

test('directory validates scoped department filters and retains options in empty branches', () => {
  assert.match(directory, /resolveDepartmentMemberIds\(supabase, tenantId, requestedDepartmentIds\)/);
  assert.match(directory, /listDepartmentOptions\(supabase, tenantId, \[organizationId\]\)/);
  assert.match(directory, /department_id is not available for this organisation/);
  // Every organization-card branch that builds a response passes departments.
  const organizationResponses = [...directory.matchAll(/buildOrganisationMembersResponse\(\{([\s\S]*?)\}\)/g)];
  assert.ok(organizationResponses.length >= 3);
  assert.ok(organizationResponses.every(match => /departments:/.test(match[1])));
});

test('unscoped public directories cannot filter by or receive department membership', () => {
  assert.match(directory, /if \(departmentId && !organizationId\)[\s\S]*status\(400\)/);
  assert.match(directory, /department_id requires an organisation-scoped directory/);
  assert.match(
    directory,
    /members: organizationId\s*\?\s*await enrichMembersWithDepartments\(supabase, tenantId, members \|\| \[\]\)\s*:\s*\(members \|\| \[\]\)/,
  );
});

test('authenticated organisation scope retains filtering, options, and enrichment', () => {
  assert.match(directory, /if \(organizationId && !tenantContext\.isAuthenticated\)/);
  assert.match(directory, /resolveDepartmentMemberIds\(supabase, tenantId, requestedDepartmentIds\)/);
  assert.match(directory, /listDepartmentOptions\(supabase, tenantId, \[organizationId\]\)/);
  assert.match(directory, /organizationId\s*\?\s*await enrichMembersWithDepartments/);
});

test('generic member detail API returns the complete department collection', () => {
  assert.match(entityById, /import \{ enrichMembersWithDepartments, MemberDepartmentError \}/);
  assert.match(entityById, /if \(entityNorm === 'member'\)/);
  assert.match(entityById, /enrichMembersWithDepartments\([\s\S]*supabase,[\s\S]*\[data\]/);
  assert.match(entityById, /departmentError instanceof MemberDepartmentError/);
});