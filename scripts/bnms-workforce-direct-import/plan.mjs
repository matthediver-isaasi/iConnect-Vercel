/**
 * Offline planner for the current direct Workforce Row -> Department model.
 * It has no database client and never writes destination state.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseSource, sourceSummary, EXPECTED_SHA256 } from '../workforce-csv-source.mjs';
import { resolveOption } from '../workforce-csv-audit.mjs';
import { PROJECT, ROW, TENANT } from '../workforce-readonly-state.mjs';

export const DEPARTMENT = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
export const DIRECT_RELATIONSHIP = 'a422da51-6005-4831-a69e-bf284ff6f124';
export const SOURCE_SHA = EXPECTED_SHA256;
export const APPROVED = Object.freeze({
  relationship: 'workforce_survey_row -> org_department (direct)',
  reportingYear: 'source-validation-only; omitted from imported data',
  primaryDisplay: 'staff_group',
  duplicates: 'preserve_all',
  blankVacancy: 'No',
  vacantWte: 'omit',
  liveImportAuthorized: false,
});

const reject = message => { throw new Error(`BNMS direct preparation blocked: ${message}`); };
// preference_field has no archived_at column in the live schema.  Object and
// relationship rows use archive/status state; fields use is_active.
const active = value => value && value.is_active !== false && !value.archived_at
  && (value.status === undefined || value.status === null || value.status === 'active');
const sorted = rows => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
export const digest = value => createHash('sha256').update(value).digest('hex');
export const serialize = value => JSON.stringify(value, null, 2) + '\n';

export function exactCanonical(field, input) {
  const match = resolveOption(field, input);
  if (match.error) reject(`${field?.name}: ${match.error}`);
  const options = field.options.map(option => typeof option === 'string' ? option : option.value);
  if (options.filter(option => option === match.value).length !== 1) reject('Canonical option is not unique');
  return match.value;
}

function one(rows, description) {
  if (rows.length !== 1) reject(`Expected exactly one ${description}`);
  return rows[0];
}

function projectedRecord(record) {
  return { id: record.id, tenant_id: record.tenant_id, custom_object_id: record.custom_object_id,
    archived_at: record.archived_at, data: record.data };
}

/**
 * Builds a first-import-only manifest from a new two-pass read-only snapshot.
 * Reporting_Year remains validated in the original source but is deliberately
 * absent from every inserted Row payload and from the provenance schema.
 */
export function buildManifest(bytes, state) {
  const source = parseSource(bytes);
  const summary = sourceSummary(source);
  if (summary.totalRows !== 1242 || summary.totalDepartments !== 136
    || summary.totalOccupiedHundredths !== 170814 || summary.normalizedVacancyCounts.No !== 1141
    || summary.normalizedVacancyCounts.Yes !== 101 || summary.originalVacancyCounts[''] !== 53
    || summary.exactDuplicates.normalized.groups !== 84
    || summary.exactDuplicates.normalized.rows !== 216
    || summary.exactDuplicates.normalized.beyondFirst !== 132) reject('Pinned source totals differ');
  if (state.tenant?.id !== TENANT || !['BNMS', 'British Nuclear Medicine Society'].includes(state.tenant?.name)) {
    reject('Pinned BNMS tenant identity changed');
  }
  const rowObject = one(state.objects.filter(object => object.id === ROW
    && object.object_key === 'workforce_survey_row' && object.tenant_id === TENANT && active(object)),
  'active Workforce Survey Row object');
  const departmentObject = one(state.objects.filter(object => object.id === DEPARTMENT
    && object.object_key === 'org_department' && object.tenant_id === TENANT && active(object)),
  'active Department object');
  if (state.objects.filter(object => object.tenant_id === TENANT && active(object)
    && object.object_key === 'workforce_survey_row').length !== 1
    || state.objects.filter(object => object.tenant_id === TENANT && active(object)
      && object.object_key === 'org_department').length !== 1) {
    reject('Active Row or Department object key is ambiguous');
  }
  const fields = state.fields.filter(field => field.custom_object_id === ROW
    && field.tenant_id === TENANT && field.entity_scope === 'custom_object' && active(field));
  const field = name => one(fields.filter(item => item.name === name), `active Row field ${name}`);
  const staffGroup = field('staff_group');
  if (staffGroup.field_type !== 'dropdown' || !staffGroup.is_required
    || rowObject.primary_display_field_id !== staffGroup.id) {
    reject('staff_group must be the required dropdown primary display field');
  }
  if (fields.some(item => item.name === 'row_name')) reject('row_name must be archived before direct import preparation');
  const expectedFields = [
    ['grade', 'dropdown', true], ['occupied_wte', 'decimal', true],
    ['legacy_vacancy_reported', 'dropdown', false],
  ];
  for (const [name, type, required] of expectedFields) {
    const item = field(name);
    if (item.field_type !== type || item.is_required !== required) reject(`Row field contract changed: ${name}`);
  }
  const direct = one(state.definitions.filter(definition => definition.id === DIRECT_RELATIONSHIP
    && definition.tenant_id === TENANT && active(definition)), 'active direct Row -> Department relationship');
  if (direct.relationship_key !== 'workforce_survey_row_department'
    || direct.source_kind !== 'custom_object' || direct.target_kind !== 'custom_object'
    || direct.source_custom_object_id !== ROW || direct.target_custom_object_id !== DEPARTMENT
    || direct.cardinality !== 'many_to_one' || direct.is_required !== true
    || !direct.show_on_source || !direct.edit_from_source) {
    reject('Pinned direct Row -> Department relationship contract changed');
  }
  if (state.definitions.some(definition => definition.tenant_id === TENANT && active(definition)
    && definition.source_custom_object_id === ROW && definition.is_required && definition.id !== DIRECT_RELATIONSHIP)) {
    reject('An additional active required Workforce Row relationship exists');
  }
  const baselineRecords = sorted(state.records.filter(record => record.custom_object_id === ROW).map(projectedRecord));
  if (baselineRecords.length !== 8 || baselineRecords.some(record => record.tenant_id !== TENANT || record.archived_at)) {
    reject('Exactly eight active pre-existing Workforce Rows must be preserved');
  }
  const baselineIds = new Set(baselineRecords.map(record => record.id));
  const baselineEdges = sorted(state.edges.filter(edge => baselineIds.has(edge.source_record_id)
    || baselineIds.has(edge.target_record_id)));
  const activeDirect = baselineEdges.filter(edge => active(edge)
    && edge.relationship_definition_id === DIRECT_RELATIONSHIP && baselineIds.has(edge.source_record_id));
  if (activeDirect.length !== 8 || new Set(activeDirect.map(edge => edge.source_record_id)).size !== 8
    || activeDirect.some(edge => edge.tenant_id !== TENANT || edge.field_values == null
      || JSON.stringify(edge.field_values) !== '{}')) {
    reject('Existing Workforce Rows must retain one empty-valued direct Department edge each');
  }
  const departments = sorted(state.departments).map(department => ({
    id: department.id, tenant_id: department.tenant_id, custom_object_id: department.custom_object_id,
    archived_at: department.archived_at,
  }));
  if (departments.length !== 136 || new Set(departments.map(department => department.id)).size !== 136
    || departments.some(department => department.tenant_id !== TENANT
      || department.custom_object_id !== DEPARTMENT || department.archived_at)) {
    reject('Pinned active Department snapshot changed');
  }
  const inputDepartments = new Set(source.rows.map(row => row.departmentId));
  if (departments.some(department => !inputDepartments.has(department.id))) reject('Department snapshot includes a non-source Department');
  const canonicalFields = new Map(['staff_group', 'grade', 'legacy_vacancy_reported'].map(name => [name, field(name)]));
  const rows = source.rows.map(row => {
    const data = {
      staff_group: exactCanonical(canonicalFields.get('staff_group'), row.data.staff_group),
      grade: exactCanonical(canonicalFields.get('grade'), row.data.grade),
      occupied_wte: row.data.occupied_wte,
      legacy_vacancy_reported: exactCanonical(canonicalFields.get('legacy_vacancy_reported'), row.data.legacy_vacancy_reported),
    };
    return { sourceLine: row.sourceRow,
      identity: digest(JSON.stringify([TENANT, ROW, source.fingerprint, row.sourceRow])),
      departmentId: row.departmentId, data };
  });
  if (rows.some(row => Object.hasOwn(row.data, 'row_name') || Object.hasOwn(row.data, 'vacant_wte'))) {
    reject('Direct payload contains retired or vacant WTE field');
  }
  return {
    version: 2, tenantId: TENANT, rowObjectId: ROW, departmentObjectId: DEPARTMENT,
    directRelationshipId: DIRECT_RELATIONSHIP, sourceSha256: source.fingerprint,
    metadata: {
      objects: sorted(state.objects.filter(object => [ROW, DEPARTMENT].includes(object.id))),
      fields: sorted(state.fields.filter(item => [ROW, DEPARTMENT].includes(item.custom_object_id))),
      definitions: sorted(state.definitions.filter(item => item.tenant_id === TENANT)),
    },
    baseline: { records: baselineRecords, edges: baselineEdges },
    departments, rows,
  };
}

export function renderInstallSql(template, manifest) {
  const token = '__BNMS_DIRECT_MANIFEST_JSON__';
  if (template.split(token).length !== 2) reject('SQL template must have exactly one manifest token');
  const json = JSON.stringify(manifest);
  if (json.includes('$manifest$')) reject('Unsafe SQL dollar-quote delimiter in manifest');
  const commitment = `${SOURCE_SHA}:${digest(json)}`;
  return `-- REVIEW ONLY: installation is a database change and is not authorized by preparation.\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '120s';\nDO $approval$ BEGIN\n  IF current_setting('bnms.final_import_approval', true) IS DISTINCT FROM '${commitment}' THEN\n    RAISE EXCEPTION 'Separate final approval of this exact direct manifest is required before installation';\n  END IF;\nEND $approval$;\n${template.replace(token, () => json)}\nCOMMIT;\n`;
}

export function renderInvokeSql() {
  return `-- REVIEW ONLY. Do not execute without separately recorded final approval.\n-- In the same transaction, an authorized service-role operator must SET LOCAL\n-- bnms.final_import_approval to <source SHA>:<reviewed manifest SHA>. This file does not set it.\n-- Use only verified destination lvmzliemqnieeoruhkik.\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '120s';\nSELECT public.import_bnms_workforce_direct_occurrences();\nCOMMIT;\n`;
}

export function verifyReplay(manifest, state, ledger) {
  if (!isDeepStrictEqual(ledger.manifest, manifest) || ledger.occurrences.length !== 1242) {
    reject('Changed-file, changed-plan, or partial ledger');
  }
  if (ledger.occurrences.some(item => item.tenant_id !== TENANT || item.row_object_id !== ROW
    || item.source_sha256 !== manifest.sourceSha256)) {
    reject('Occurrence ledger has a foreign, wrong-object, or wrong-source SHA entry');
  }
  const records = new Map(state.records.map(record => [record.id, record]));
  const edges = new Map(state.edges.map(edge => [edge.id, edge]));
  const used = new Set(), usedEdges = new Set();
  for (const expected of manifest.rows) {
    const matches = ledger.occurrences.filter(item => item.source_line === expected.sourceLine);
    if (matches.length !== 1) reject('Ambiguous occurrence identity');
    const item = matches[0], record = records.get(item.record_id), edge = edges.get(item.edge_id);
    if (item.tenant_id !== TENANT || item.row_object_id !== ROW || item.source_sha256 !== manifest.sourceSha256
      || item.occurrence_identity !== expected.identity || item.department_id !== expected.departmentId
      || !isDeepStrictEqual(item.data, expected.data) || !record || record.tenant_id !== TENANT
      || record.custom_object_id !== ROW || record.archived_at || !isDeepStrictEqual(record.data, expected.data)
      || !edge || edge.tenant_id !== TENANT || edge.archived_at
      || edge.relationship_definition_id !== DIRECT_RELATIONSHIP || edge.source_record_id !== item.record_id
      || edge.target_record_id !== expected.departmentId || !isDeepStrictEqual(edge.field_values, {})
      || used.has(item.record_id) || usedEdges.has(item.edge_id)) reject('Occurrence, record, or direct parent edge drift');
    used.add(item.record_id); usedEdges.add(item.edge_id);
  }
  if (state.edges.some(edge => (used.has(edge.source_record_id) || used.has(edge.target_record_id)) && !usedEdges.has(edge.id))) {
    reject('Unexpected active or historical imported-row incident edge');
  }
  for (const record of manifest.baseline.records) {
    if (!isDeepStrictEqual(projectedRecord(records.get(record.id) || {}), record)) reject('Existing eight-row baseline changed');
  }
  const baselineIds = new Set(manifest.baseline.records.map(record => record.id));
  const incident = sorted(state.edges.filter(edge => baselineIds.has(edge.source_record_id) || baselineIds.has(edge.target_record_id)));
  if (!isDeepStrictEqual(incident, manifest.baseline.edges)) reject('Existing eight-row baseline edges changed');
  if (state.records.some(record => record.tenant_id === TENANT && record.custom_object_id === ROW
    && !baselineIds.has(record.id) && !used.has(record.id))) reject('Unprovenanced Workforce Row overlap');
  return { rowsReused: 1242, edgesReused: 1242, writes: 0 };
}