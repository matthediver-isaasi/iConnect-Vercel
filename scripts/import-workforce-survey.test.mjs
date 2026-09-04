import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  EXPECTED_SHA256, FILE, SURVEY_OBJECT_ID, TENANT_ID,
  auditContract, makePlan, naturalRowKey, parseWorkbookBytes,
} from './import-workforce-survey.mjs';

function fixture() {
  const source = parseWorkbookBytes(readFileSync(FILE));
  const survey = {
    id: SURVEY_OBJECT_ID, tenant_id: TENANT_ID, object_key: 'workforce_survey',
    singular_label: 'Workforce survey', status: 'active',
  };
  const row = {
    id: 'bf123bdb-7227-4f45-b5f9-8344d0f65446', tenant_id: TENANT_ID,
    object_key: 'workforce_survey_row', singular_label: 'Workforce Survey Row', status: 'active',
  };
  const department = {
    id: 'cd1ebfd3-3e16-4091-be5a-99992d926f2f', tenant_id: TENANT_ID,
    object_key: 'org_department', status: 'active',
  };
  const field = (id, objectId, name, label, field_type, is_required, options = null) => ({
    id, tenant_id: TENANT_ID, custom_object_id: objectId, entity_scope: 'custom_object',
    name, label, field_type, is_required, is_active: true, options,
  });
  const opts = (values) => values.map((value) => ({ label: value, value }));
  const fields = [
    field('s', survey.id, 'survey_name', 'Reporting year', 'text', true),
    field('r1', row.id, 'row_name', 'Row name', 'text', true),
    field('r2', row.id, 'staff_group', 'Staff group', 'dropdown', true, opts([...new Set(source.rows.map((x) => x.data.staff_group))])),
    field('r3', row.id, 'grade', 'Grade', 'dropdown', true, opts([...new Set(source.rows.map((x) => x.data.grade))])),
    field('r4', row.id, 'occupied_wte', 'Occupied WTE', 'decimal', true),
    field('r5', row.id, 'vacant_wte', 'Vacant WTE', 'decimal', false),
    field('r6', row.id, 'legacy_vacancy_reported', 'Legacy vacancy reported', 'dropdown', false, opts(['No', 'Yes', 'Unknown'])),
  ];
  const definitions = [
    {
      id: 'rs', tenant_id: TENANT_ID, relationship_key: 'workforce_survey_row_survey',
      source_kind: 'custom_object', target_kind: 'custom_object',
      source_custom_object_id: row.id, target_custom_object_id: survey.id,
      cardinality: 'many_to_one', is_required: true, source_label: 'Workforce Survey',
      target_label: 'Workforce Survey Rows', show_on_source: true, edit_from_source: true,
      status: 'active',
    },
    {
      id: 'rd', tenant_id: TENANT_ID, relationship_key: 'workforce_survey_department',
      source_kind: 'custom_object', target_kind: 'custom_object',
      source_custom_object_id: row.id, target_custom_object_id: department.id,
      cardinality: 'many_to_one', is_required: true, source_label: 'Department',
      target_label: 'Workforce Survey Rows', show_on_source: true, edit_from_source: true,
      status: 'active',
    },
  ];
  const departments = [...new Set(source.rows.map((x) => x.departmentId))].map((id) => ({
    id, tenant_id: TENANT_ID, custom_object_id: department.id, archived_at: null, data: { name: id },
  }));
  return { source, state: { objects: [survey, row, department], fields, definitions, departments, departmentObject: department, records: [], edges: [] } };
}

test('pinned workbook preserves all eight blank Vacant WTE cells', () => {
  const source = parseWorkbookBytes(readFileSync(FILE));
  assert.equal(source.fingerprint, EXPECTED_SHA256);
  assert.equal(source.rows.length, 8);
  assert.ok(source.rows.every((row) => !Object.hasOwn(row.data, 'vacant_wte')));
});

test('workbook contract drift and duplicate natural keys fail closed', () => {
  const bytes = readFileSync(FILE);
  assert.throws(() => parseWorkbookBytes(Buffer.concat([bytes, Buffer.from('x')])), /fingerprint mismatch/);
  const { source } = fixture();
  assert.equal(new Set(source.rows.map(naturalRowKey)).size, 8);
});

test('valid metadata and Departments produce one survey and eight creates', () => {
  const { source, state } = fixture();
  const contract = auditContract(source, state);
  assert.deepEqual(contract.blockers, []);
  const plan = makePlan(source, state, contract);
  assert.equal(plan.survey.action, 'create');
  assert.equal(plan.rows.filter((row) => row.action === 'create').length, 8);
});

test('dropdown labels resolve to their canonical stored option values', () => {
  const { source, state } = fixture();
  const staff = state.fields.find((field) => field.name === 'staff_group');
  const supplied = source.rows[0].data.staff_group;
  staff.options.find((option) => option.label === supplied).value = `${supplied} `;
  const contract = auditContract(source, state);
  assert.deepEqual(contract.blockers, []);
  assert.equal(contract.canonicalRows[0].data.staff_group, `${supplied} `);
  assert.equal(makePlan(source, state, contract).rows[0].source.data.staff_group, `${supplied} `);
});

test('missing or cross-tenant Departments and metadata/option drift block writes', () => {
  const { source, state } = fixture();
  state.departments[0].tenant_id = '00000000-0000-4000-8000-000000000000';
  state.fields.find((field) => field.name === 'staff_group').options = [];
  state.fields.find((field) => field.name === 'vacant_wte').is_required = true;
  const contract = auditContract(source, state);
  assert.ok(contract.blockers.some((value) => value.includes('cross-tenant')));
  assert.ok(contract.blockers.some((value) => value.includes('Unsupported live staff_group')));
  assert.ok(contract.blockers.some((value) => value.includes('vacant_wte')));
  assert.equal(makePlan(source, state, contract).blocked, true);
});

test('rerun reconciliation reuses the survey, rows, and both edge sets', () => {
  const { source, state } = fixture();
  const contract = auditContract(source, state);
  const surveyRecord = { id: 'survey-record', custom_object_id: SURVEY_OBJECT_ID, archived_at: null, data: { survey_name: '2025/26' } };
  state.records.push(surveyRecord);
  source.rows.forEach((sourceRow, index) => {
    const id = `row-${index}`;
    state.records.push({ id, custom_object_id: contract.rowObject.id, archived_at: null, data: sourceRow.data });
    state.edges.push(
      { id: `s-${index}`, relationship_definition_id: contract.rowSurveyDefinition.id, source_record_id: id, target_record_id: surveyRecord.id, archived_at: null },
      { id: `d-${index}`, relationship_definition_id: contract.rowDepartmentDefinition.id, source_record_id: id, target_record_id: sourceRow.departmentId, archived_at: null },
    );
  });
  const plan = makePlan(source, state, contract);
  assert.equal(plan.survey.action, 'reuse');
  assert.ok(plan.rows.every((row) => row.action === 'reuse' && row.edgeAction === 'reuse'));
});

test('duplicate destination rows fail reconciliation instead of duplicating', () => {
  const { source, state } = fixture();
  const contract = auditContract(source, state);
  const sourceRow = source.rows[0];
  for (const id of ['duplicate-a', 'duplicate-b']) {
    state.records.push({ id, custom_object_id: contract.rowObject.id, archived_at: null, data: sourceRow.data });
    state.edges.push({ id: `edge-${id}`, relationship_definition_id: contract.rowDepartmentDefinition.id, source_record_id: id, target_record_id: sourceRow.departmentId, archived_at: null });
  }
  assert.throws(() => makePlan(source, state, contract), /natural key is ambiguous/);
});

test('a data-identical row with a missing Department edge blocks reconciliation', () => {
  const { source, state } = fixture();
  const contract = auditContract(source, state);
  state.records.push({
    id: 'malformed-row', custom_object_id: contract.rowObject.id,
    archived_at: null, data: source.rows[0].data,
  });
  assert.throws(() => makePlan(source, state, contract), /0 active Department edges/);
});