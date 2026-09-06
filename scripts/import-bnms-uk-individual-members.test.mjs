import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  ASSIGNMENT_COUNTS, COLUMN_COUNT, CORE_MAPPINGS, CUSTOM_MAPPINGS, EXPECTED_FILE_SHA256,
  FILE, FOCUS_AREA, HEADERS, ROW_COUNT, SHEET_NAME, auditFocusArea, auditHierarchy,
  auditMappings, auditUnassigned, makePlan, parseSourceBytes, parseUsDate, pendingItems,
} from './import-bnms-uk-individual-members.mjs';
import { TENANT_ID } from './import-bnms-direct-debit-members.mjs';

const bytes = readFileSync(FILE); const source = parseSourceBytes(bytes);
function mutate(mutator) {
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: false });
  for (let index = 0; index < source.rows.length; index += 1) {
    workbook.Sheets[SHEET_NAME][`B${index + 2}`] = { t: 's', v: source.rows[index].values[1] };
    workbook.Sheets[SHEET_NAME][`D${index + 2}`] = { t: 's', v: source.rows[index].values[3] };
  }
  mutator(workbook.Sheets[SHEET_NAME]);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
const fields = CUSTOM_MAPPINGS.map(m => ({
  id: m.id, tenant_id: TENANT_ID, name: m.name, label: m.label, field_type: m.type,
  entity_scope: 'member', is_active: true,
  options: m.type === 'dropdown' ? [...new Set(source.rows.map(r => r.values[m.column]).filter(Boolean))].map(value => ({ value, label: value })) : null,
}));
const category = { id: FOCUS_AREA.id, tenant_id: TENANT_ID, name: FOCUS_AREA.name, is_active: true, subcategories: [...new Set(source.rows.flatMap(r => r.values[28].split('|')).filter(Boolean))] };
const mappings = auditMappings(fields, source); const focus = auditFocusArea([category], source);
const defs = [
  { id: 'parent', tenant_id: TENANT_ID, relationship_key: 'organisation', source_kind: 'custom_object', source_custom_object_id: 'dept-object', target_kind: 'organization', cardinality: 'many_to_one', status: 'active' },
  { id: 'member', tenant_id: TENANT_ID, relationship_key: 'members', source_kind: 'custom_object', source_custom_object_id: 'dept-object', target_kind: 'member', cardinality: 'many_to_many', status: 'active', configuration: { picker_scope: { version: 2, match: 'intersects', source_path: [{ relationship_definition_id: 'parent', from_side: 'source' }], target_path: [{ relationship_definition_id: '601544ca-9db9-498e-bd03-0af5e2c2e8a0', from_side: 'target' }, { relationship_definition_id: '184b26ff-c918-4162-98c4-1e16fde737ad', from_side: 'source' }] } } },
  { id: '601544ca-9db9-498e-bd03-0af5e2c2e8a0', tenant_id: TENANT_ID, relationship_key: 'assignment_member', source_kind: 'custom_object', source_custom_object_id: '1c1cdab9-5128-4e3d-b09e-b97088ae69ba', target_kind: 'member', cardinality: 'many_to_one', status: 'active' },
  { id: '184b26ff-c918-4162-98c4-1e16fde737ad', tenant_id: TENANT_ID, relationship_key: 'assignment_organisation_v2', source_kind: 'custom_object', source_custom_object_id: '1c1cdab9-5128-4e3d-b09e-b97088ae69ba', target_kind: 'organization', cardinality: 'many_to_one', status: 'active' },
];
const ids = c => [...new Set(source.rows.map(r => r.values[c]).filter(Boolean))];
const groups = ids(18).map(id => ({ id, tenant_id: TENANT_ID }));
const organizations = [...new Set([...ids(19), ...ids(20).map(id => `parent-${id}`)])].map(id => ({ id, tenant_id: TENANT_ID }));
const departments = ids(20).map(id => ({ id, tenant_id: TENANT_ID, custom_object_id: 'dept-object', archived_at: null }));
const parentEdges = departments.map(d => ({ id: `edge-${d.id}`, tenant_id: TENANT_ID, relationship_definition_id: 'parent', source_record_id: d.id, target_record_id: `parent-${d.id}`, archived_at: null }));
const hierarchyState = { groups, organizations, departments, relationshipDefinitions: defs, parentEdges };
const hierarchy = auditHierarchy(source, hierarchyState);

test('pins exact workbook, positional columns, identities, and hierarchy counts', () => {
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256); assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT); assert.deepEqual(source.counts, ASSIGNMENT_COUNTS);
  assert.equal(new Set(source.rows.map(r => r.email)).size, ROW_COUNT); assert.equal(new Set(source.rows.map(r => r.legacyId)).size, ROW_COUNT);
  assert.deepEqual([...CORE_MAPPINGS.map(m => m.column), ...CUSTOM_MAPPINGS.map(m => m.column), 18, 19, 20, 28].sort((a, b) => a - b), [...Array(COLUMN_COUNT).keys()]);
});
test('validates US dates, emails, identity uniqueness, controlled values and exclusive hierarchy', () => {
  assert.equal(parseUsDate('2/29/24'), '2024-02-29'); assert.throws(() => parseUsDate('2/29/23'), /Invalid/);
  assert.throws(() => parseSourceBytes(Buffer.from('wrong')), /fingerprint mismatch/);
  assert.throws(() => parseSourceBytes(mutate(s => { s.J3.v = s.J2.v.toUpperCase(); }), { verifyFingerprint: false }), /Duplicate normalized email/);
  assert.throws(() => parseSourceBytes(mutate(s => { s.A3.v = s.A2.v; }), { verifyFingerprint: false }), /Duplicate legacy ID/);
  assert.throws(() => parseSourceBytes(mutate(s => { s.B2.v = '13/1/26'; }), { verifyFingerprint: false }), /Invalid Member Since/);
  assert.throws(() => parseSourceBytes(mutate(s => {
    s.S2 = { t: 's', v: '00000000-0000-4000-8000-000000000001' };
    s.T2 = { t: 's', v: '00000000-0000-4000-8000-000000000002' };
  }), { verifyFingerprint: false }), /more than one hierarchy/);
  assert.throws(() => parseSourceBytes(mutate(s => { s.X2 = { t: 's', v: 'MAYBE' }; }), { verifyFingerprint: false }), /invalid SRP/);
});
test('audits exact fields, dropdowns, Focus Area multi-select values and hierarchy ownership', () => {
  assert.equal(mappings.length, CUSTOM_MAPPINGS.length); assert.equal(focus.id, FOCUS_AREA.id);
  const occupation = fields.find(f => f.name === 'occupation');
  assert.throws(() => auditMappings(fields.map(f => f === occupation ? { ...f, options: [] } : f), source), /Unsupported "Occupation"/);
  assert.throws(() => auditFocusArea([{ ...category, subcategories: category.subcategories.slice(1) }], source), /Unsupported Focus Area/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, groups: groups.slice(1) }), /outside BNMS/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, parentEdges: parentEdges.slice(1) }), /exactly one BNMS/);
  const malformedScope = defs.map(def => def.id === 'member' ? {
    ...def, configuration: { picker_scope: { ...def.configuration.picker_scope, match: 'union' } },
  } : def);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, relationshipDefinitions: malformedScope }), /picker-scope assignment model drifted/);
});
function replayState(row) {
  const member = { id: 'member', tenant_id: TENANT_ID, email: row.email, first_name: row.values[6], last_name: row.values[7], created_on: parseUsDate(row.values[1]), mobile: row.values[17], organization_group_id: row.values[18] || null, organization_id: row.values[19] || (row.values[20] ? hierarchy.departmentParents.get(row.values[20]) : null) };
  return {
    identityMembers: [member], members: [member],
    allLegacy: [{ member_id: member.id, value: row.legacyId }],
    preferenceValues: mappings.filter(m => row.values[m.column]).map(m => ({ id: m.id, member_id: member.id, field_id: m.id, value: m.transform === 'boolean' ? (row.values[m.column] === 'TRUE' ? 'true' : 'false') : row.values[m.column] })),
    memberCategories: row.values[28].split('|').filter(Boolean).map((name, i) => ({ id: `cat-${i}`, member_id: member.id, resource_category_id: focus.id, subcategory_name: name })),
    memberEdges: row.values[20] ? [
      { id: 'edge', tenant_id: TENANT_ID, relationship_definition_id: 'member', source_record_id: row.values[20], target_record_id: member.id, archived_at: null },
      { id: 'assignment-member', tenant_id: TENANT_ID, relationship_definition_id: '601544ca-9db9-498e-bd03-0af5e2c2e8a0', source_record_id: 'assignment', target_record_id: member.id, archived_at: null },
    ] : [],
    assignmentOrganizationEdges: row.values[20] ? [{
      id: 'assignment-org', tenant_id: TENANT_ID, relationship_definition_id: '184b26ff-c918-4162-98c4-1e16fde737ad',
      source_record_id: 'assignment', target_record_id: hierarchy.departmentParents.get(row.values[20]), archived_at: null,
    }] : [],
    assignmentRecords: row.values[20] ? [{
      id: 'assignment', tenant_id: TENANT_ID, custom_object_id: '1c1cdab9-5128-4e3d-b09e-b97088ae69ba', archived_at: null,
    }] : [],
  };
}
test('reconciles dual identities, rejects split and cross-tenant matches, and replays zero writes', () => {
  const row = source.rows.find(r => r.values[20] && r.values[28]); const state = replayState(row);
  const replay = makePlan({ ...source, rows: [row] }, state, mappings, hierarchy, focus);
  assert.equal(replay.items[0].action, 'unchanged'); assert.equal(replay.items[0].assignmentAction, 'unchanged'); assert.equal(pendingItems(replay).length, 0);
  const missingAssignment = makePlan({ ...source, rows: [row] }, { ...state, assignmentOrganizationEdges: [] }, mappings, hierarchy, focus);
  assert.equal(missingAssignment.items[0].assignmentAction, 'insert'); assert.equal(pendingItems(missingAssignment).length, 1);
  const archivedAssignment = makePlan({ ...source, rows: [row] }, {
    ...state, assignmentRecords: state.assignmentRecords.map(record => ({ ...record, archived_at: '2026-01-01' })),
  }, mappings, hierarchy, focus);
  assert.equal(archivedAssignment.items[0].assignmentAction, 'insert');
  assert.throws(() => makePlan({ ...source, rows: [row] }, { ...state, identityMembers: [state.members[0], { ...state.members[0], id: 'other', email: 'old@example.test' }], allLegacy: [{ member_id: 'other', value: row.legacyId }] }, mappings, hierarchy, focus), /match different/);
  assert.throws(() => makePlan({ ...source, rows: [row] }, { ...state, identityMembers: [{ ...state.members[0], tenant_id: 'other' }] }, mappings, hierarchy, focus), /outside BNMS/);
});
test('unassigned rows preserve existing assignments and new rows require nullable columns', () => {
  const row = source.rows.find(r => !r.values[18] && !r.values[19] && !r.values[20]); const state = replayState(row);
  state.members[0].organization_id = 'preserve'; state.identityMembers = state.members;
  const existing = makePlan({ ...source, rows: [row] }, state, mappings, hierarchy, focus);
  assert.equal('organization_id' in existing.items[0].patch, false);
  const fresh = makePlan({ ...source, rows: [row] }, { identityMembers: [], members: [], allLegacy: [], preferenceValues: [], memberCategories: [], memberEdges: [] }, mappings, hierarchy, focus);
  assert.throws(() => auditUnassigned({ memberAssignmentNullability: null }, fresh), /nullable/);
  assert.doesNotThrow(() => auditUnassigned({ memberAssignmentNullability: { organization_id: true, organization_group_id: true } }, fresh));
});