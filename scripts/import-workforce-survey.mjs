#!/usr/bin/env node
/**
 * Pinned, dry-run-first import of the supplied 2025/26 Workforce Survey.
 *
 * Usage:
 *   node scripts/import-workforce-survey.mjs
 *   node scripts/import-workforce-survey.mjs --apply
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILE = path.join(ROOT, 'attached_assets', 'Sample_Workforce_data_1788536544654.xlsx');
export const EXPECTED_SHA256 = 'f85374976acdb625f36dc58465eae9160f3853e4ade2d6abea07d719f68739ad';
export const SHEET = 'Sheet1';
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const SURVEY_OBJECT_ID = '931df885-c3b7-449a-b206-eef31fb9e883';
export const HEADERS = Object.freeze([
  'Department_UUID', 'row_name', 'staff_group', 'grade', 'occupied_wte',
  'Vacant WTE', 'legacy_vacancy_reported',
]);
export const ROW_COUNT = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message) => { throw new Error(message); };
const check = (error, context) => { if (error) fail(`${context}: ${error.message}`); };
const clean = (value) => typeof value === 'string' ? value.normalize('NFKC').trim() : value;

export function parseWorkbookBytes(bytes, { verifyFingerprint = true } = {}) {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (verifyFingerprint && fingerprint !== EXPECTED_SHA256) {
    fail(`Workbook fingerprint mismatch; expected ${EXPECTED_SHA256}, found ${fingerprint}.`);
  }
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: true, cellDates: false });
  if (workbook.SheetNames.length !== 1 || workbook.SheetNames[0] !== SHEET) {
    fail(`Workbook must contain only "${SHEET}".`);
  }
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[SHEET], {
    header: 1, raw: true, defval: null, blankrows: false,
  });
  if (grid.length !== ROW_COUNT + 1 || grid[0].length !== HEADERS.length
    || grid[0].some((value, index) => value !== HEADERS[index])) {
    fail(`Workbook must have the exact ${HEADERS.length}-column header and ${ROW_COUNT}-row contract.`);
  }
  const rows = grid.slice(1).map((input, index) => {
    const sourceRow = index + 2;
    if (input.length !== HEADERS.length) fail(`Workbook row ${sourceRow} must have exactly ${HEADERS.length} cells.`);
    const values = input.map(clean);
    if (!UUID_RE.test(values[0] || '')) fail(`Workbook row ${sourceRow} has an invalid Department UUID.`);
    if (values[1] !== '2025/26') fail(`Workbook row ${sourceRow} has unexpected row_name "${values[1]}".`);
    if (!values[2] || !values[3]) fail(`Workbook row ${sourceRow} has a blank staff group or grade.`);
    for (const column of [4, 5]) {
      if (values[column] !== null && (typeof values[column] !== 'number' || !Number.isFinite(values[column]))) {
        fail(`Workbook row ${sourceRow} has a non-numeric ${HEADERS[column]}.`);
      }
    }
    if (values[4] === null) fail(`Workbook row ${sourceRow} has blank occupied_wte.`);
    if (!['No', 'Yes', 'Unknown'].includes(values[6])) {
      fail(`Workbook row ${sourceRow} has unsupported legacy_vacancy_reported "${values[6]}".`);
    }
    return {
      sourceRow,
      departmentId: values[0],
      data: {
        row_name: values[1],
        staff_group: values[2],
        grade: values[3],
        occupied_wte: values[4],
        ...(values[5] === null ? {} : { vacant_wte: values[5] }),
        legacy_vacancy_reported: values[6],
      },
    };
  });
  const keys = rows.map(naturalRowKey);
  if (new Set(keys).size !== keys.length) fail('Workbook contains duplicate natural row keys.');
  return { fingerprint, sheet: SHEET, rows, reportingYear: '2025/26' };
}

export const readSource = (file = FILE) => parseWorkbookBytes(readFileSync(file));
export const naturalRowKey = (row) => [
  row.departmentId, row.data.row_name, row.data.staff_group, row.data.grade,
  row.data.occupied_wte, Object.hasOwn(row.data, 'vacant_wte') ? row.data.vacant_wte : '<blank>',
  row.data.legacy_vacancy_reported,
].join('|');

function canonicalOption(field, supplied) {
  const configured = field.options || [];
  const valueMatches = configured.filter((option) => option?.value === supplied);
  if (valueMatches.length === 1) return valueMatches[0].value;
  const labelMatches = configured.filter((option) => option?.label === supplied);
  if (labelMatches.length === 1) return labelMatches[0].value;
  if (valueMatches.length + labelMatches.length > 1) {
    fail(`Live ${field.name} options ambiguously resolve supplied value "${supplied}".`);
  }
  return undefined;
}

export function auditContract(source, state) {
  const blockers = [];
  const object = state.objects.find((item) => item.id === SURVEY_OBJECT_ID);
  if (!object || object.tenant_id !== TENANT_ID || object.status !== 'active'
    || object.object_key !== 'workforce_survey' || object.singular_label !== 'Workforce survey') {
    blockers.push('Target Workforce survey object identity, tenant, key, label, or active status drifted.');
  }
  const rowObjects = state.objects.filter((item) => item.object_key === 'workforce_survey_row');
  if (rowObjects.length !== 1 || rowObjects[0].tenant_id !== TENANT_ID || rowObjects[0].status !== 'active') {
    blockers.push(`Expected one active Workforce Survey Row object; found ${rowObjects.length}.`);
  }
  const rowObject = rowObjects[0] || null;
  const surveyFields = state.fields.filter((field) => field.custom_object_id === SURVEY_OBJECT_ID && field.is_active);
  const rowFields = state.fields.filter((field) => field.custom_object_id === rowObject?.id && field.is_active);
  const expectedSurvey = [{ name: 'survey_name', label: 'Reporting year', type: 'text', required: true }];
  const expectedRows = [
    { name: 'row_name', label: 'Row name', type: 'text', required: true },
    { name: 'staff_group', label: 'Staff group', type: 'dropdown', required: true },
    { name: 'grade', label: 'Grade', type: 'dropdown', required: true },
    { name: 'occupied_wte', label: 'Occupied WTE', type: 'decimal', required: true },
    { name: 'vacant_wte', label: 'Vacant WTE', type: 'decimal', required: false },
    { name: 'legacy_vacancy_reported', label: 'Legacy vacancy reported', type: 'dropdown', required: false },
  ];
  const resolveFields = (contracts, fields, label) => Object.fromEntries(contracts.map((contract) => {
    const matches = fields.filter((field) => field.name === contract.name);
    if (matches.length !== 1) {
      blockers.push(`${label} field "${contract.name}" must resolve exactly once; found ${matches.length}.`);
      return [contract.name, null];
    }
    const field = matches[0];
    if (field.label !== contract.label || field.field_type !== contract.type || field.is_required !== contract.required) {
      blockers.push(`${label} field "${contract.name}" metadata drifted (expected ${contract.type}, required=${contract.required}).`);
    }
    return [contract.name, field];
  }));
  const surveyFieldMap = resolveFields(expectedSurvey, surveyFields, 'Survey');
  const rowFieldMap = resolveFields(expectedRows, rowFields, 'Row');
  for (const [name, requested] of [
    ['staff_group', source.rows.map((row) => row.data.staff_group)],
    ['grade', source.rows.map((row) => row.data.grade)],
    ['legacy_vacancy_reported', source.rows.map((row) => row.data.legacy_vacancy_reported)],
  ]) {
    const field = rowFieldMap[name];
    if (field) {
      const unsupported = [...new Set(requested)].filter((value) => canonicalOption(field, value) === undefined);
      if (unsupported.length) blockers.push(`Unsupported live ${name} option(s): ${unsupported.join(', ')}.`);
    }
  }
  const surveyRowDefs = state.definitions.filter((definition) =>
    definition.status === 'active' && definition.relationship_key === 'workforce_survey_row_survey');
  const rowSurvey = surveyRowDefs.find((definition) =>
    definition.source_custom_object_id === rowObject?.id
    && definition.target_custom_object_id === SURVEY_OBJECT_ID);
  if (surveyRowDefs.length !== 1 || !rowSurvey || rowSurvey.cardinality !== 'many_to_one'
    || rowSurvey.source_kind !== 'custom_object' || rowSurvey.target_kind !== 'custom_object'
    || !rowSurvey.is_required || !rowSurvey.show_on_source || !rowSurvey.edit_from_source
    || rowSurvey.source_label !== 'Workforce Survey'
    || !['Workforce Survey Rows', 'Workfroce Survey Rows'].includes(rowSurvey.target_label)) {
    blockers.push('The Workforce Survey Rows relationship must be one required many-to-one Row → Survey definition.');
  }
  const departmentDefs = state.definitions.filter((definition) =>
    definition.status === 'active' && definition.relationship_key === 'workforce_survey_department');
  const rowDepartment = departmentDefs.find((definition) =>
    definition.source_custom_object_id === rowObject?.id
    && definition.target_custom_object_id === state.departmentObject?.id);
  if (departmentDefs.length !== 1 || !rowDepartment || rowDepartment.cardinality !== 'many_to_one'
    || rowDepartment.source_kind !== 'custom_object' || rowDepartment.target_kind !== 'custom_object'
    || !rowDepartment.is_required || !rowDepartment.show_on_source || !rowDepartment.edit_from_source) {
    blockers.push('Department must be one required many-to-one Workforce Survey Row → Department relationship.');
  }
  const departments = new Map(state.departments.map((department) => [department.id, department]));
  for (const row of source.rows) {
    const department = departments.get(row.departmentId);
    if (!department || department.tenant_id !== TENANT_ID || department.archived_at
      || department.custom_object_id !== state.departmentObject?.id) {
      blockers.push(`Row ${row.sourceRow}: Department ${row.departmentId} is missing, archived, cross-tenant, or the wrong object.`);
    }
  }
  const canonicalRows = source.rows.map((row) => ({
    ...row,
    data: {
      ...row.data,
      ...Object.fromEntries(['staff_group', 'grade', 'legacy_vacancy_reported'].map((name) => [
        name,
        rowFieldMap[name] ? (canonicalOption(rowFieldMap[name], row.data[name]) ?? row.data[name]) : row.data[name],
      ])),
    },
  }));
  return {
    blockers: [...new Set(blockers)],
    object, rowObject, surveyFields: surveyFieldMap, rowFields: rowFieldMap,
    rowSurveyDefinition: rowSurvey || null, rowDepartmentDefinition: rowDepartment || null,
    canonicalRows,
  };
}

export function makePlan(source, state, contract) {
  if (contract.blockers.length) return { blocked: true, survey: null, rows: [] };
  const surveys = state.records.filter((record) => record.custom_object_id === SURVEY_OBJECT_ID
    && !record.archived_at && record.data?.survey_name === source.reportingYear);
  if (surveys.length > 1) fail(`Natural survey key "${source.reportingYear}" is ambiguous (${surveys.length} records).`);
  const survey = surveys[0] || null;
  const rowRecords = state.records.filter((record) => record.custom_object_id === contract.rowObject.id && !record.archived_at);
  const edges = state.edges.filter((edge) => !edge.archived_at);
  const rows = contract.canonicalRows.map((row) => {
    const dataMatches = rowRecords.filter((record) =>
      Object.entries(row.data).every(([key, value]) => record.data?.[key] === value)
      && Object.keys(record.data || {}).every((key) => Object.hasOwn(row.data, key)));
    for (const record of dataMatches) {
      const departmentEdges = edges.filter((edge) =>
        edge.relationship_definition_id === contract.rowDepartmentDefinition.id
        && edge.source_record_id === record.id);
      if (departmentEdges.length !== 1) {
        fail(`Row ${row.sourceRow} matches record ${record.id}, which has ${departmentEdges.length} active Department edges.`);
      }
    }
    const candidates = rowRecords.filter((record) => naturalRowKey({
      departmentId: edges.find((edge) => edge.relationship_definition_id === contract.rowDepartmentDefinition.id
        && edge.source_record_id === record.id)?.target_record_id || '',
      data: record.data,
    }) === naturalRowKey(row));
    if (candidates.length > 1) fail(`Row ${row.sourceRow} natural key is ambiguous (${candidates.length} records).`);
    const record = candidates[0] || null;
    const surveyEdges = record ? edges.filter((edge) => edge.relationship_definition_id === contract.rowSurveyDefinition.id
      && edge.source_record_id === record.id) : [];
    if (surveyEdges.length > 1) fail(`Row ${row.sourceRow} has duplicate active Survey edges.`);
    if (record && survey && surveyEdges[0]?.target_record_id !== survey.id) {
      fail(`Row ${row.sourceRow} already belongs to a different survey.`);
    }
    return { source: row, record, action: record ? 'reuse' : 'create', edgeAction: record && surveyEdges.length ? 'reuse' : 'create' };
  });
  return { blocked: false, survey: { record: survey, action: survey ? 'reuse' : 'create' }, rows };
}

async function loadState(db, source) {
  const objectResult = await db.from('custom_object_definition').select('*').eq('tenant_id', TENANT_ID);
  check(objectResult.error, 'Could not load Custom Objects');
  const rowObject = (objectResult.data || []).find((item) => item.object_key === 'workforce_survey_row');
  const departmentObject = (objectResult.data || []).find((item) => item.object_key === 'org_department');
  const relevantIds = [SURVEY_OBJECT_ID, rowObject?.id].filter(Boolean);
  const [fields, definitions, departments, records, edges] = await Promise.all([
    db.from('preference_field').select('*').eq('tenant_id', TENANT_ID).eq('entity_scope', 'custom_object').in('custom_object_id', relevantIds),
    db.from('custom_object_relationship_definition').select('*').eq('tenant_id', TENANT_ID)
      .or(relevantIds.flatMap((id) => [`source_custom_object_id.eq.${id}`, `target_custom_object_id.eq.${id}`]).join(',')),
    db.from('custom_object_record').select('*').eq('tenant_id', TENANT_ID).in('id', [...new Set(source.rows.map((row) => row.departmentId))]),
    fetchAll(db, 'custom_object_record', '*', (query) => query.eq('tenant_id', TENANT_ID).in('custom_object_id', relevantIds)),
    fetchAll(db, 'custom_object_relationship', '*', (query) => query.eq('tenant_id', TENANT_ID)),
  ]);
  for (const [result, label] of [[fields, 'fields'], [definitions, 'relationships'], [departments, 'Departments']]) check(result.error, `Could not load ${label}`);
  return {
    objects: objectResult.data || [], fields: fields.data || [], definitions: definitions.data || [],
    departments: departments.data || [], records, edges, departmentObject,
  };
}

async function fetchAll(db, table, columns, configure) {
  const rows = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await configure(db.from(table).select(columns).order('id').range(from, from + 499));
    check(error, `Could not load ${table}`);
    rows.push(...(data || []));
    if ((data || []).length < 500) return rows;
  }
}

export async function applyPlan(db, source, contract, plan) {
  if (plan.blocked) fail(`Import blocked: ${contract.blockers.join(' ')}`);
  const { data, error } = await db.rpc('import_pinned_workforce_survey', {
    p_tenant_id: TENANT_ID,
    p_survey_object_id: SURVEY_OBJECT_ID,
    p_row_object_id: contract.rowObject.id,
    p_survey_relationship_id: contract.rowSurveyDefinition.id,
    p_department_relationship_id: contract.rowDepartmentDefinition.id,
    p_reporting_year: source.reportingYear,
    p_rows: contract.canonicalRows.map((row) => ({ department_id: row.departmentId, data: row.data })),
    p_actor: 'system:workforce-survey-import',
  });
  check(error, 'Atomic Workforce Survey import failed');
  return data;
}

export function verify(source, state, contract) {
  const plan = makePlan(source, state, contract);
  if (plan.blocked || !plan.survey?.record || plan.rows.some((row) => !row.record || row.edgeAction !== 'reuse')) {
    fail('Post-import verification failed: survey, rows, values, or links do not exactly match the workbook.');
  }
  if (plan.rows.length !== ROW_COUNT) fail(`Post-import verification found ${plan.rows.length}/${ROW_COUNT} rows.`);
  return { surveys: 1, rows: ROW_COUNT, departmentLinks: ROW_COUNT, surveyLinks: ROW_COUNT };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply')) fail('Only --apply is supported.');
  const apply = args.includes('--apply');
  if (!process.env.DEST_SUPABASE_URL || !process.env.DEST_SUPABASE_KEY) fail('DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required.');
  const db = createClient(process.env.DEST_SUPABASE_URL, process.env.DEST_SUPABASE_KEY, { auth: { persistSession: false } });
  const source = readSource();
  const state = await loadState(db, source);
  const contract = auditContract(source, state);
  const plan = makePlan(source, state, contract);
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run', workbook: { fingerprint: source.fingerprint, sheet: source.sheet, rows: source.rows.length },
    resolved: {
      surveyObject: contract.object && { id: contract.object.id, key: contract.object.object_key, label: contract.object.singular_label },
      rowObject: contract.rowObject && { id: contract.rowObject.id, key: contract.rowObject.object_key, label: contract.rowObject.singular_label },
      surveyFields: Object.fromEntries(Object.entries(contract.surveyFields).map(([key, field]) => [key, field?.id || null])),
      rowFields: Object.fromEntries(Object.entries(contract.rowFields).map(([key, field]) => [key, field?.id || null])),
      rowSurveyRelationship: contract.rowSurveyDefinition?.id || null,
      rowDepartmentRelationship: contract.rowDepartmentDefinition?.id || null,
      departments: state.departments.map((item) => ({ id: item.id, name: item.data?.name })),
    },
    blockers: contract.blockers,
    intended: plan.blocked ? null : {
      survey: plan.survey.action,
      rowsCreate: plan.rows.filter((item) => item.action === 'create').length,
      rowsReuse: plan.rows.filter((item) => item.action === 'reuse').length,
    },
  }, null, 2));
  if (contract.blockers.length) fail(`DRY RUN blocked without writes: ${contract.blockers.join(' ')}`);
  if (!apply) return console.log('DRY RUN complete: no writes.');
  const counts = await applyPlan(db, source, contract, plan);
  const verifiedState = await loadState(db, source);
  const verification = verify(source, verifiedState, auditContract(source, verifiedState));
  console.log(JSON.stringify({ counts, verification }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}