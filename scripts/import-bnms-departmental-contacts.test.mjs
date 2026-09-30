import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVED_DEPARTMENT_REPLACEMENTS, APPROVED_LEGACY_ID_REPLACEMENTS, COLUMN_COUNT, CORE_MAPPINGS,
  CUSTOM_MAPPINGS, DEPARTMENT_COUNT, EXPECTED_FILE_SHA256, HEADERS, ROW_COUNT, auditHierarchy,
  auditLegacyIdReplacementContract, auditMappings, makePlan, parseSourceBytes, readSource,
} from './import-bnms-departmental-contacts.mjs';
import { TENANT_ID, parseBritishDate } from './import-bnms-direct-debit-members.mjs';

function csvBytes(rows) {
  const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return Buffer.from(rows.map((row) => row.map(cell).join(',')).join('\r\n'));
}
const rows = Array.from({ length: ROW_COUNT }, (_, index) => [
  `YM-${index + 1}`,
  `10000000-0000-4000-8000-${String((index % DEPARTMENT_COUNT) + 1).padStart(12, '0')}`,
  'Fixture', `Contact ${index + 1}`, `contact-${index + 1}@example.test`,
  '06/12/2018', 'Active', 'Department contact', 'Hospital Department',
]);
const source = parseSourceBytes(csvBytes([HEADERS, ...rows]), { verifyFingerprint: false });
const fields = CUSTOM_MAPPINGS.map((mapping) => ({
  ...mapping, tenant_id: TENANT_ID, field_type: mapping.type, entity_scope: 'member', is_active: true,
  options: mapping.type === 'dropdown'
    ? [{ value: mapping.valueMap?.[rows[0][mapping.column]] ?? rows[0][mapping.column], label: mapping.valueMap?.[rows[0][mapping.column]] ?? rows[0][mapping.column] }]
    : null,
}));
const definitions = [
  { id: 'parent-def', tenant_id: TENANT_ID, relationship_key: 'organisation', source_kind: 'custom_object', source_custom_object_id: 'department-object', target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one', is_required: true, status: 'active' },
  { id: 'member-def', tenant_id: TENANT_ID, relationship_key: 'members', source_kind: 'custom_object', source_custom_object_id: 'department-object', target_kind: 'member', target_custom_object_id: null, cardinality: 'many_to_many', is_required: false, status: 'active' },
];
const departments = [...source.departmentIds].map((id) => ({ id, tenant_id: TENANT_ID, custom_object_id: 'department-object', archived_at: null }));
const organizations = [
  ...departments.map((item) => ({ id: `org-${item.id}`, tenant_id: TENANT_ID })),
];
const replacementDepartments = Object.values(APPROVED_DEPARTMENT_REPLACEMENTS).map((id) => ({ id, tenant_id: TENANT_ID, custom_object_id: 'department-object', archived_at: null }));
const replacementOrganizations = replacementDepartments.map((item) => ({ id: `org-${item.id}`, tenant_id: TENANT_ID }));
const allDepartments = [...departments, ...replacementDepartments];
const allOrganizations = [...organizations, ...replacementOrganizations];
const parentEdges = allDepartments.map((item) => ({ id: `edge-${item.id}`, tenant_id: TENANT_ID, relationship_definition_id: 'parent-def', source_record_id: item.id, target_record_id: `org-${item.id}`, archived_at: null }));
const hierarchyState = { departments: allDepartments, organizations: allOrganizations, parentEdges, relationshipDefinitions: definitions };
const mappings = auditMappings(fields, source);
const hierarchy = auditHierarchy(source, hierarchyState);

function mutate(mutator) {
  const grid = [HEADERS, ...source.rows.map((row) => [...row.values])];
  mutator(grid);
  return parseSourceBytes(csvBytes(grid), { verifyFingerprint: false });
}

test('pins the exact nine-column, 174-contact and 167-Department source', () => {
  assert.equal(readSource().fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.equal(source.departmentIds.size, DEPARTMENT_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.legacyId)).size, ROW_COUNT);
  assert.equal(Object.keys(APPROVED_LEGACY_ID_REPLACEMENTS).length, 53);
  assert.doesNotThrow(() => auditLegacyIdReplacementContract(readSource()));
});

test('rejects fingerprint, identity, required-value, email, date, UUID and constant drift', () => {
  assert.throws(() => parseSourceBytes(Buffer.from('changed')), /fingerprint mismatch/);
  assert.throws(() => mutate((grid) => { grid[2][4] = grid[1][4].toUpperCase(); }), /Duplicate normalized Email/);
  assert.throws(() => mutate((grid) => { grid[2][0] = grid[1][0]; }), /Duplicate YM Web Site Member ID/);
  assert.throws(() => mutate((grid) => { grid[1][2] = ''; }), /populate all nine/);
  assert.throws(() => mutate((grid) => { grid[1][4] = 'bad'; }), /invalid Email/);
  assert.throws(() => mutate((grid) => { grid[1][5] = '31\\/2\\/2020'; }), /Invalid/);
  assert.throws(() => mutate((grid) => { grid[1][1] = 'bad'; }), /invalid Department UUID/);
  assert.throws(() => mutate((grid) => { grid[1][7] = 'Other'; }), /Member class values drifted/);
});

test('requires exact active field contracts and supported options', () => {
  assert.deepEqual([...CORE_MAPPINGS, ...CUSTOM_MAPPINGS].map((item) => item.column).sort((a, b) => a - b), [0, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(() => auditMappings(fields.slice(1), source), /unambiguous/);
  assert.throws(() => auditMappings(fields.map((field, i) => i ? field : { ...field, is_active: false }), source), /contract drifted/);
  assert.throws(() => auditMappings(fields.map((field) => field.name === 'member_class' ? { ...field, options: [] } : field), source), /Unsupported/);
  assert.deepEqual(mappings.find((mapping) => mapping.name === 'ym_membership_type').requested, ['Hospital Departmental Contact']);
});

test('fails closed on missing, archived, cross-tenant, ambiguous and orphaned Departments', () => {
  assert.equal(hierarchy.departmentParents.size, DEPARTMENT_COUNT);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, departments: departments.slice(1) }), /missing/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, departments: departments.map((row, i) => i ? row : { ...row, archived_at: 'now' }) }), /archived/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, departments: departments.map((row, i) => i ? row : { ...row, tenant_id: 'foreign' }) }), /outside BNMS/);
  const ordinaryIndex = allDepartments.findIndex((row) => !Object.hasOwn(APPROVED_DEPARTMENT_REPLACEMENTS, row.id));
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, parentEdges: [...parentEdges, { ...parentEdges[ordinaryIndex], id: 'duplicate' }] }), /exactly one active/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, parentEdges: parentEdges.filter((_, index) => index !== ordinaryIndex) }), /exactly one active/);
});

test('approved replacement Departments must resolve to active BNMS parent chains', () => {
  const [sourceDepartmentId, replacementDepartmentId] = Object.entries(APPROVED_DEPARTMENT_REPLACEMENTS)[0];
  const replacementSource = {
    ...source,
    departmentIds: new Set([...source.departmentIds, sourceDepartmentId]),
  };
  const audited = auditHierarchy(replacementSource, hierarchyState);
  assert.ok(audited.effectiveDepartmentIds.has(replacementDepartmentId));
  assert.equal(audited.effectiveDepartmentIds.has(sourceDepartmentId), false);
  assert.equal(audited.departmentParents.get(replacementDepartmentId), `org-${replacementDepartmentId}`);
  assert.throws(() => auditHierarchy(replacementSource, {
    ...hierarchyState,
    departments: allDepartments.filter((row) => row.id !== replacementDepartmentId),
  }), /missing/);
});

test('plans lowercase creates and additive relationships, then replays idempotently', () => {
  const row = source.rows[0];
  const created = makePlan({ ...source, rows: [row] }, { members: [], preferenceValues: [], memberEdges: [] }, mappings, hierarchy).items[0];
  assert.equal(created.action, 'insert');
  assert.equal(created.patch.email, row.email);
  assert.equal(created.patch.created_on, parseBritishDate(row.values[5]));
  assert.equal(created.patch.organization_id, hierarchy.departmentParents.get(created.departmentId));
  assert.equal(created.edgeAction, 'insert');
  assert.equal(created.preferences.find((pref) => pref.mapping.name === 'ym_membership_type').desired, 'Hospital Departmental Contact');

  const member = { id: 'member', tenant_id: TENANT_ID, organization_id: created.patch.organization_id, ...created.patch };
  const preferenceValues = created.preferences.map((pref) => ({ id: pref.mapping.id, member_id: member.id, field_id: pref.mapping.id, value: pref.desired }));
  const desired = { id: 'desired', tenant_id: TENANT_ID, relationship_definition_id: 'member-def', source_record_id: row.departmentId, target_record_id: member.id, archived_at: null };
  const extra = { ...desired, id: 'extra', source_record_id: 'another-department' };
  const replay = makePlan({ ...source, rows: [row] }, { members: [member], preferenceValues, memberEdges: [desired, extra] }, mappings, hierarchy).items[0];
  assert.equal(replay.action, 'unchanged');
  assert.ok(replay.preferences.every((pref) => pref.action === 'unchanged'));
  assert.equal(replay.edgeAction, 'unchanged');
  assert.deepEqual(replay.activeDepartmentEdges, [desired, extra]);
});

test('legacy member ID is a collision guard and blank/unmanaged data is preserved', () => {
  const row = source.rows[0];
  const member = { id: 'member', tenant_id: TENANT_ID, email: row.email, biography: 'keep me' };
  const legacy = mappings.find((mapping) => mapping.column === 0);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    members: [member],
    preferenceValues: [{ id: 'legacy', member_id: member.id, field_id: legacy.id, value: 'different' }],
    memberEdges: [],
  }, mappings, hierarchy), /Legacy member ID collision/);
  const approved = makePlan({
    ...source, approvedLegacyIdReplacements: { [row.email]: ['different', row.legacyId] }, rows: [row],
  }, {
    members: [member],
    preferenceValues: [{ id: 'legacy', member_id: member.id, field_id: legacy.id, value: 'different' }],
    memberEdges: [],
  }, mappings, hierarchy);
  assert.equal(approved.items[0].preferences.find((pref) => pref.mapping.id === legacy.id).action, 'update');
  assert.throws(() => makePlan({
    ...source, approvedLegacyIdReplacements: { [row.email]: ['another-value', row.legacyId] }, rows: [row],
  }, {
    members: [member],
    preferenceValues: [{ id: 'legacy', member_id: member.id, field_id: legacy.id, value: 'different' }],
    memberEdges: [],
  }, mappings, hierarchy), /Legacy member ID collision/);
  const plan = makePlan({ ...source, rows: [row] }, { members: [member], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.equal('biography' in plan.items[0].patch, false);
});