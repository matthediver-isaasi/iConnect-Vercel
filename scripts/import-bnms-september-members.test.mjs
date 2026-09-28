import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { FILE, SHA256, FIELDS, HEADERS, TENANT_ID, dateValue, parseSourceBytes } from './bnms-september-source.mjs';
import { makeReport, main, FOCUS, ASSIGNMENT_OBJECT, ASSIGNMENT_MEMBER, ASSIGNMENT_ORG } from './import-bnms-september-members.mjs';
const bytes = readFileSync(FILE);
const source = parseSourceBytes(bytes);
function mutate(fn) {
  const w = XLSX.read(bytes, { type: 'buffer' }); fn(w.Sheets.Sheet1);
  return parseSourceBytes(XLSX.write(w, { type: 'buffer', bookType: 'xlsx' }), { verifyFingerprint: false });
}
test('pins September source without earlier exclusions or cohort permissions', () => {
  assert.equal(source.fingerprint, SHA256); assert.equal(source.rows.length, 31);
  assert.equal(HEADERS.length, 18);
  assert.deepEqual(source.counts, { group: 4, organization: 9, department: 8, none: 10 });
  assert.equal(source.rows.filter(r => r.reasons.length).length, 0);
  assert.equal(source.rows.find(r => r.sourceRow === 7).departmentIds.length, 2);
  assert.equal(source.rows.filter(r => r.departmentIds.length > 1).length, 1);
  assert.throws(() => parseSourceBytes(Buffer.from('changed')), /fingerprint/);
});
test('noon Excel fractions retain calendar day, phone strings retain source text', () => {
  assert.equal(dateValue({ t: 'n', v: 46022.5 }), dateValue({ t: 'n', v: 46022 }));
  assert.throws(() => dateValue({ t: 'n', v: NaN }));
  const s = mutate(s => { s.K2 = { t: 's', v: '01234 567890' }; });
  assert.equal(s.rows[0].values[10], '01234 567890');
  assert.ok(mutate(s => { s.K2 = { t: 'n', v: 123456 }; }).rows[0].reasons.some(r => /Phone/.test(r)));
});
test('formulas, malformed dates, invalid booleans and duplicate normalized identities hold', () => {
  assert.ok(mutate(s => { s.F2.f = '"name"'; }).rows[0].reasons.some(r => /Formula/.test(r)));
  assert.ok(mutate(s => { s.C2 = { t: 's', v: 'unknown' }; }).rows[0].reasons.includes('Invalid expiry'));
  assert.ok(mutate(s => { s.P2 = { t: 's', v: 'YES' }; }).rows[0].reasons.includes('Invalid affiliate boolean'));
  const duplicate = mutate(s => { s.I3.v = s.I2.v.toUpperCase(); s.A3.v = s.A2.v; });
  assert.ok(duplicate.rows[0].reasons.includes('Duplicate source email'));
  assert.ok(duplicate.rows[1].reasons.includes('Duplicate source legacyId'));
  assert.ok(mutate(s => { s.N7.v += ';'; }).rows[5].reasons.some(r => /Department UUID/.test(r)));
});
function fixture() {
  const row = structuredClone(source.rows.find(r => !r.values.slice(11, 14).some(Boolean)));
  const fields = FIELDS.map(f => ({ ...f, tenant_id: TENANT_ID, entity_scope: 'member', field_type: f.type, is_active: true, options: f.type === 'dropdown' ? [{ value: row.values[f.column] }] : null }));
  const state = { fields, categories: [{ id: FOCUS, name: 'Focus Area', tenant_id: TENANT_ID, is_active: true, subcategories: row.focusAreas }], groups: [], organizations: [], departments: [], definitions: [], edges: [], automaticGroups: [], members: [], legacy: [], preferences: [], memberCategories: [] };
  const schema = { columns: ['first_name', 'last_name', 'email', 'mobile', 'organization_id', 'organization_group_id'].map(column_name => ({ table_name: 'member', column_name, data_type: 'text', is_nullable: 'YES' })), triggers: [{ relname: 'member', tgname: 'queue_insert', tgenabled: 'O', definition: 'automatic_membership', function: '' }] };
  return { row, state, schema, src: { ...source, rows: [row] } };
}
test('unassigned new rows remain globally held and CLI cannot bypass gate', async () => {
  const f = fixture(); const report = makeReport(f.src, f.state, f.schema);
  assert.equal(report.rows[0].outcome, 'held-side-effects');
  assert.equal(report.rows[0].organizationId, null);
  assert.equal(report.safety.mutationStatements, 0);
  for (const args of [['--apply'], ['--allow-existing-regional-rules'], ['--file=other']]) await assert.rejects(main(args), /no apply authorized/);
});
test('foreign/split identities, unsupported options and missing hierarchy cannot be adopted', () => {
  const f = fixture();
  f.state.legacy = [{ member_id: 'foreign', value: f.row.legacyId }];
  assert.ok(makeReport(f.src, f.state, f.schema).rows[0].reasons.includes('Missing or foreign legacy identity'));
  f.state.members = [{ id: 'local', tenant_id: TENANT_ID, email: f.row.email }];
  assert.ok(makeReport(f.src, f.state, f.schema).rows[0].reasons.some(r => /Ambiguous email/.test(r)));
  f.row.values[11] = 'missing';
  f.state.fields.find(x => x.type === 'dropdown').options = [];
  const report = makeReport(f.src, f.state, f.schema);
  assert.ok(report.rows[0].reasons.some(r => /Unsupported option/.test(r)));
  assert.ok(report.rows[0].reasons.some(r => /groups reference/.test(r)));
});
test('matching existing identity is unchanged; nonblank conflict and missing additions hold', () => {
  const f = fixture(); const member = { id: 'owned', tenant_id: TENANT_ID, email: f.row.email, first_name: f.row.values[5], last_name: f.row.values[6], mobile: f.row.values[10] };
  f.state.members = [member]; f.state.legacy = [{ member_id: member.id, value: f.row.legacyId }];
  f.state.preferences = FIELDS.filter(m => f.row.values[m.column]).map(m => ({ member_id: member.id, field_id: m.id, value: f.row.values[m.column] }));
  f.state.memberCategories = f.row.focusAreas.map(subcategory_name => ({ member_id: member.id, resource_category_id: FOCUS, subcategory_name }));
  assert.equal(makeReport(f.src, f.state, f.schema).rows[0].outcome, 'already-present-matching');
  member.first_name = 'different';
  assert.equal(makeReport(f.src, f.state, f.schema).rows[0].outcome, 'held-validation');
});
test('each Department resolves independently; distinct parents get all assignments and no arbitrary primary', () => {
  const f = fixture();
  f.row.values[13] = 'd1; d2'; f.row.departmentIds = ['d1', 'd2'];
  f.state.objects = [{ id: 'department-object', status: 'active' }, { id: ASSIGNMENT_OBJECT, status: 'active' }];
  f.state.departments = ['d1', 'd2'].map(id => ({ id, tenant_id: TENANT_ID, custom_object_id: 'department-object', archived_at: null }));
  f.state.organizations = ['o1', 'o2'].map(id => ({ id, tenant_id: TENANT_ID, archived_at: null }));
  f.state.definitions = [
    { id: 'parent', source_custom_object_id: 'department-object', source_kind: 'custom_object', target_kind: 'organization', status: 'active', relationship_key: 'organisation', cardinality: 'many_to_one' },
    { id: 'members', source_custom_object_id: 'department-object', source_kind: 'custom_object', target_kind: 'member', status: 'active', relationship_key: 'members', cardinality: 'many_to_many',
      configuration: { picker_scope: { version: 2, match: 'intersects', source_path: [{ relationship_definition_id: 'parent', from_side: 'source' }], target_path: [{ relationship_definition_id: ASSIGNMENT_MEMBER, from_side: 'target' }, { relationship_definition_id: ASSIGNMENT_ORG, from_side: 'source' }] } } },
    ...[[ASSIGNMENT_MEMBER, 'member'], [ASSIGNMENT_ORG, 'organization']].map(([id, target_kind]) => ({ id, tenant_id: TENANT_ID, status: 'active', source_kind: 'custom_object', source_custom_object_id: ASSIGNMENT_OBJECT, cardinality: 'many_to_one', target_kind })),
  ];
  f.state.edges = [1, 2].map(i => ({ source_record_id: `d${i}`, target_record_id: `o${i}`, relationship_definition_id: 'parent' }));
  const report = makeReport(f.src, f.state, f.schema);
  assert.equal(report.rows[0].outcome, 'held-side-effects');
  assert.equal(report.rows[0].organizationId, null);
  assert.equal(report.rows[0].departmentLinks.length, 2);
  assert.deepEqual(report.rows[0].parentOrganizationIds, ['o1', 'o2']);
  f.state.edges[1].target_record_id = 'o1';
  const shared = makeReport(f.src, f.state, f.schema).rows[0];
  assert.equal(shared.departmentLinks.length, 2);
  assert.deepEqual(shared.parentOrganizationIds, ['o1']);
  f.state.departments[1].tenant_id = 'foreign';
  assert.equal(makeReport(f.src, f.state, f.schema).rows[0].outcome, 'held-validation');
});