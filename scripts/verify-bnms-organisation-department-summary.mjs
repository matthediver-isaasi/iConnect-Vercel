/**
 * Read-only destination verification after applying inclusive-report migrations.
 * Does not insert export jobs or mutate any tenant records. Table scans here
 * build an independent reference result, not the application execution path.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createCustomObjectService } from '../api/_lib/customObjectService.js';

const tenantId = 'ff2df806-b321-4254-b651-3af11fccf1db';
const objectId = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) {
  throw new Error('Destination Supabase configuration is required');
}
const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, {
  auth: { persistSession: false },
});
async function all(table, columns, configure = (query) => query) {
  const result = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await configure(db.from(table).select(columns).eq('tenant_id', tenantId))
      .order('id', { ascending: true }).range(from, from + 499);
    if (error) throw new Error(error.message);
    result.push(...data);
    if (data.length < 500) return result;
  }
}
const [settings, definitions, departments, organizations, members] = await Promise.all([
  all('system_settings', 'id,setting_value', (q) => q.eq('setting_key', `custom_object_reports_${objectId}`)),
  all('custom_object_relationship_definition', '*', (q) => q.eq('status', 'active')),
  all('custom_object_record', 'id,data', (q) => q.eq('custom_object_id', objectId).is('archived_at', null)),
  all('organization', 'id,name'),
  all('member', 'id'),
]);
assert.equal(settings.length, 1);
const reports = JSON.parse(settings[0].setting_value).reports;
const summary = reports.find((r) => r.id === 'bnms_organisation_department_summary');
const legacy = reports.find((r) => r.id === 'bnms_department_members');
assert.equal(legacy?.config.version, 1);
const referenceOnly = process.argv.includes('--reference-only');
if (!referenceOnly) {
  assert.ok(summary, 'Apply the new saved-summary migration first');
  assert.equal(summary.config.version, 2);
}
const orgRelationship = definitions.find((d) =>
  d.source_custom_object_id === objectId && d.relationship_key === 'organisation');
const memberRelationship = definitions.find((d) =>
  d.source_custom_object_id === objectId && d.relationship_key === 'members');
assert.ok(orgRelationship && memberRelationship);
const edges = await all('custom_object_relationship', 'id,relationship_definition_id,source_record_id,target_record_id',
  (q) => q.in('relationship_definition_id', [orgRelationship.id, memberRelationship.id]).is('archived_at', null));
const validDepartments = new Set(departments.map((r) => r.id));
const validMembers = new Set(members.map((r) => r.id));
const expected = new Map();
let emptyOrganizations = 0;
let emptyDepartments = 0;
for (const organization of organizations) {
  const departmentEdges = edges.filter((e) => e.relationship_definition_id === orgRelationship.id
    && e.target_record_id === organization.id && validDepartments.has(e.source_record_id));
  if (!departmentEdges.length) {
    emptyOrganizations += 1;
    expected.set(`${organization.id}/-`, { organization: organization.name || '', count: 0, missing: true });
  }
  for (const edge of departmentEdges) {
    const count = new Set(edges.filter((e) => e.relationship_definition_id === memberRelationship.id
      && e.source_record_id === edge.source_record_id && validMembers.has(e.target_record_id))
      .map((e) => e.target_record_id)).size;
    if (!count) emptyDepartments += 1;
    expected.set(`${organization.id}/${edge.id}`, { organization: organization.name || '', count, missing: false });
  }
}
const service = createCustomObjectService({
  db, context: { isAuthenticated: true, tenantId, tenantUserId: 'read-only-verification' },
  isAdmin: true,
});
const seen = new Set();
if (!referenceOnly) {
for (let page = 1; ; page += 1) {
  const result = await service.previewReport(objectId, { definition: summary.config, page, pageSize: 50 });
  assert.equal(result.total, expected.size);
  for (const row of result.data) {
    assert.ok(!seen.has(row.id), 'Preview repeated an occurrence');
    seen.add(row.id);
    const reference = expected.get(row.id);
    assert.ok(reference, 'Preview emitted an unexpected occurrence');
    assert.equal(row.values[0], reference.organization);
    assert.equal(row.values[2], reference.count);
    if (reference.missing) assert.equal(row.values[1], 'No departments');
  }
  if (!result.has_more) break;
}
assert.equal(seen.size, expected.size);
const beyond = await service.previewReport(objectId, {
  definition: summary.config, page: expected.size + 2, pageSize: 50,
});
assert.equal(beyond.total, expected.size);
assert.deepEqual(beyond.data, []);
}
console.log(JSON.stringify({
  verified: !referenceOnly, referenceOnly,
  organizationCount: organizations.length, rowCount: expected.size,
  emptyOrganizations, emptyDepartments,
  legacyDefinitionDigest: createHash('sha256').update(JSON.stringify(legacy)).digest('hex'),
  sourceWrites: 0,
}, null, 2));