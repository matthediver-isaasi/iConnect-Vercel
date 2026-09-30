import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FILE, parseSource } from '../workforce-csv-source.mjs';
import { PROJECT, ROW, TENANT, stateFingerprint } from '../workforce-readonly-state.mjs';
import { DEPARTMENT, DIRECT_RELATIONSHIP, SOURCE_SHA, buildManifest, digest, renderInstallSql, verifyReplay } from './plan.mjs';
import { main as prepare } from './prepare.mjs';

const sourceBytes = fs.readFileSync(FILE);
const source = parseSource(sourceBytes);
function fixture() {
  const staff = { id: '10000000-0000-0000-0000-000000000001', tenant_id: TENANT, custom_object_id: ROW,
    entity_scope: 'custom_object', name: 'staff_group', field_type: 'dropdown', is_required: true, is_active: true,
    archived_at: null, options: ['Clinical Practitioner – Technologist ', 'Clinical Practitioner – Radiographer ',
      'Assistant Practitioner ', 'Nurse', 'Scientist', 'Other'] };
  // Use all actual supplied options rather than weakening canonical matching.
  staff.options = [...new Set(source.rows.map(row => row.data.staff_group).map(value =>
    ['Clinical Practitioner – Technologist', 'Clinical Practitioner – Radiographer', 'Assistant Practitioner'].includes(value)
      ? `${value} ` : value))];
  const grade = { id: '10000000-0000-0000-0000-000000000002', tenant_id: TENANT, custom_object_id: ROW,
    entity_scope: 'custom_object', name: 'grade', field_type: 'dropdown', is_required: true, is_active: true,
    archived_at: null, options: [...new Set(source.rows.map(row => row.data.grade).map(value => value === 'Fellow' ? 'Fellow ' : value))] };
  const vacancy = { id: '10000000-0000-0000-0000-000000000003', tenant_id: TENANT, custom_object_id: ROW,
    entity_scope: 'custom_object', name: 'legacy_vacancy_reported', field_type: 'dropdown', is_required: false,
    is_active: true, archived_at: null, options: ['No', 'Yes'] };
  const wte = { id: '10000000-0000-0000-0000-000000000004', tenant_id: TENANT, custom_object_id: ROW,
    entity_scope: 'custom_object', name: 'occupied_wte', field_type: 'decimal', is_required: true, is_active: true,
    archived_at: null, options: null };
  const records = Array.from({ length: 8 }, (_, index) => ({ id: `baseline-row-${index}`, tenant_id: TENANT,
    custom_object_id: ROW, archived_at: null, data: { staff_group: 'Nurse', grade: 'Band 5', occupied_wte: 1,
      legacy_vacancy_reported: 'No' } }));
  return {
    tenant: { id: TENANT, name: 'BNMS' },
    objects: [{ id: ROW, tenant_id: TENANT, object_key: 'workforce_survey_row', status: 'active',
      archived_at: null, primary_display_field_id: staff.id },
    { id: DEPARTMENT, tenant_id: TENANT, object_key: 'org_department', status: 'active', archived_at: null }],
    fields: [staff, grade, vacancy, wte],
    definitions: [{ id: DIRECT_RELATIONSHIP, tenant_id: TENANT, relationship_key: 'workforce_survey_row_department',
      status: 'active', source_kind: 'custom_object', target_kind: 'custom_object', source_custom_object_id: ROW,
      target_custom_object_id: DEPARTMENT, cardinality: 'many_to_one', is_required: true, show_on_source: true,
      edit_from_source: true, configuration: {} }],
    records,
    edges: records.map((record, index) => ({ id: `baseline-edge-${index}`, tenant_id: TENANT,
      relationship_definition_id: DIRECT_RELATIONSHIP, source_record_id: record.id,
      target_record_id: source.rows[index].departmentId, archived_at: null, field_values: {} })),
    departments: [...new Set(source.rows.map(row => row.departmentId))].map(id => ({
      id, tenant_id: TENANT, custom_object_id: DEPARTMENT, archived_at: null })),
  };
}
const state = fixture();
const manifest = buildManifest(sourceBytes, state);

function imported() {
  const records = structuredClone(state.records), edges = structuredClone(state.edges), occurrences = [];
  for (const row of manifest.rows) {
    const record_id = `imported-${row.identity}`, edge_id = `edge-${row.identity}`;
    records.push({ id: record_id, tenant_id: TENANT, custom_object_id: ROW, archived_at: null, data: structuredClone(row.data) });
    edges.push({ id: edge_id, tenant_id: TENANT, relationship_definition_id: DIRECT_RELATIONSHIP,
      source_record_id: record_id, target_record_id: row.departmentId, archived_at: null, field_values: {} });
    occurrences.push({ tenant_id: TENANT, row_object_id: ROW, source_sha256: SOURCE_SHA, source_line: row.sourceLine,
      occurrence_identity: row.identity, department_id: row.departmentId, record_id, edge_id, data: structuredClone(row.data) });
  }
  return { state: { ...structuredClone(state), records, edges }, ledger: { manifest, occurrences } };
}

test('direct manifest preserves occurrences while omitting annual/survey fields', () => {
  assert.equal(manifest.rows.length, 1242);
  assert.equal(manifest.departments.length, 136);
  assert.ok(manifest.rows.every(row => Object.keys(row.data).sort().join(',') === 'grade,legacy_vacancy_reported,occupied_wte,staff_group'));
  assert.ok(manifest.rows.every(row => !Object.hasOwn(row.data, 'row_name') && !Object.hasOwn(row.data, 'vacant_wte')));
  assert.equal(new Set(manifest.rows.map(row => row.identity)).size, 1242);
  assert.equal(manifest.rows.filter(row => row.data.legacy_vacancy_reported === 'No').length, 1141);
  assert.equal(manifest.rows.some(row => row.data.staff_group.endsWith(' ')), true);
});
test('direct replay is exact and refuses changed direct parents', () => {
  const simulation = imported();
  assert.deepEqual(verifyReplay(manifest, simulation.state, simulation.ledger), { rowsReused: 1242, edgesReused: 1242, writes: 0 });
  const otherDepartment = manifest.rows.find(row => row.departmentId !== manifest.rows[0].departmentId).departmentId;
  simulation.state.edges.find(edge => edge.id === simulation.ledger.occurrences[0].edge_id).target_record_id = otherDepartment;
  assert.throws(() => verifyReplay(manifest, simulation.state, simulation.ledger), /direct parent edge drift/);
});
test('direct replay rejects a wrong-source provenance entry even with 1,242 rows', () => {
  const simulation = imported();
  simulation.ledger.occurrences[0].source_sha256 = '0'.repeat(64);
  assert.throws(() => verifyReplay(manifest, simulation.state, simulation.ledger), /wrong-source SHA/);
});
test('retired row_name and non-staff primary display fail closed', () => {
  const rowName = structuredClone(state);
  rowName.fields.push({ ...rowName.fields[0], id: 'row-name', name: 'row_name', field_type: 'text' });
  assert.throws(() => buildManifest(sourceBytes, rowName), /row_name must be archived/);
  const primary = structuredClone(state);
  primary.objects[0].primary_display_field_id = primary.fields[1].id;
  assert.throws(() => buildManifest(sourceBytes, primary), /primary display/);
});
test('live field retirement uses is_active, not an unavailable archived_at column', () => {
  const retired = structuredClone(state);
  const rowName = { ...retired.fields[0], id: 'retired-row-name', name: 'row_name',
    field_type: 'text', is_required: false, is_active: false };
  delete rowName.archived_at;
  retired.fields.push(rowName);
  assert.equal(buildManifest(sourceBytes, retired).rows.length, 1242);
});
test('offline preparation requires matching GET evidence and produces compact review artifacts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bnms-direct-test-'));
  const statePath = path.join(temp, 'state.json'), observationPath = path.join(temp, 'observation.json'), output = path.join(temp, 'out');
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(observationPath, JSON.stringify({ project: PROJECT, completePasses: 2, stableAcrossPasses: true,
    databaseWrites: 0, fingerprint: stateFingerprint(state), firstPassPagination: [{ complete: true, count: 1, rowsRead: 1 }],
    secondPassPagination: [{ complete: true, count: 1, rowsRead: 1 }] }));
  const review = prepare([statePath, observationPath, output]);
  const compact = fs.readFileSync(path.join(output, 'manifest.json'), 'utf8');
  assert.equal(review.manifestSha256, digest(compact));
  assert.equal(compact.endsWith('\n'), false);
  assert.ok(fs.existsSync(path.join(output, 'report.html')));
  fs.rmSync(temp, { recursive: true, force: true });
});
test('renderer binds exact compact manifest approval commitment', () => {
  const rendered = renderInstallSql('$manifest$__BNMS_DIRECT_MANIFEST_JSON__$manifest$', manifest);
  assert.match(rendered, new RegExp(`${SOURCE_SHA}:${digest(JSON.stringify(manifest))}`));
});