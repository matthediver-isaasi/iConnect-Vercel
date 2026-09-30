/**
 * Offline, pinned preparation only. No database client, SQL execution, or writes.
 * The separate review-only SQL implements the future atomic import.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseSource, sourceSummary, EXPECTED_SHA256 } from '../workforce-csv-source.mjs';
import { auditSourceAgainstState, resolveOption } from '../workforce-csv-audit.mjs';
import { TENANT, ROW, SURVEY } from '../workforce-readonly-state.mjs';

export const DEPARTMENT = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
export const SOURCE_SHA = EXPECTED_SHA256;
export const APPROVED = Object.freeze({
  duplicates: 'preserve_all',
  mapping: 'report-exact-canonical',
  blankVacancy: 'No',
  vacantWte: 'omit',
  liveImportAuthorized: false,
});
const reject = message => { throw new Error(`BNMS preparation blocked: ${message}`); };
const sorted = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
export const digest = text => createHash('sha256').update(text).digest('hex');
export const serialize = value => JSON.stringify(value, null, 2) + '\n';

export function exactCanonical(field, input) {
  const match = resolveOption(field, input);
  if (match.error) reject(`${field?.name}: ${match.error}`);
  // Deliberately do not call the normal record validator, which trims options.
  const options = field.options.map(o => typeof o === 'string' ? o : o.value);
  if (options.filter(value => value === match.value).length !== 1) reject('Canonical option is not unique');
  return match.value;
}

export function buildManifest(bytes, state) {
  const source = parseSource(bytes);
  const summary = sourceSummary(source);
  if (summary.totalRows !== 1242 || summary.totalDepartments !== 136
    || summary.totalOccupiedHundredths !== 170814 || summary.normalizedVacancyCounts.No !== 1141
    || summary.normalizedVacancyCounts.Yes !== 101 || summary.originalVacancyCounts[''] !== 53
    || summary.exactDuplicates.normalized.groups !== 84
    || summary.exactDuplicates.normalized.rows !== 216
    || summary.exactDuplicates.normalized.beyondFirst !== 132) reject('Pinned source totals differ');
  const audit = auditSourceAgainstState(source, state);
  const blockers = audit.blockers.filter(b => b.code !== 'OPTION_WRITE_COMPATIBILITY');
  if (blockers.length) reject(blockers.map(b => `${b.code}: ${b.message}`).join('; '));
  // Preparation is for the approved first import. It must never adopt existing
  // records by values, including previously imported copies with no ledger.
  if (audit.counts.surveys.create !== 136 || audit.counts.rows.create !== 1242
    || audit.counts.existingActiveSurveys !== 3 || audit.counts.existingActiveRows !== 8
    || audit.counts.existingArchivedSurveys || audit.counts.existingArchivedRows
    || audit.counts.outsideSurveysPreserved !== 3 || audit.counts.outsideRowsPreserved !== 8) {
    reject('Existing workforce baseline or source overlap differs; review, do not regenerate/adopt');
  }
  const relevant = new Set([SURVEY, ROW, DEPARTMENT]);
  const objects = sorted(state.objects.filter(o => relevant.has(o.id)));
  if (objects.length !== 3 || !objects.some(o => o.id === DEPARTMENT && o.object_key === 'org_department')) {
    reject('Pinned Department object changed');
  }
  const records = sorted(state.records.filter(r => [SURVEY, ROW].includes(r.custom_object_id)));
  const recordIds = new Set(records.map(r => r.id));
  const baselineEdges = sorted(state.edges.filter(e => recordIds.has(e.source_record_id) || recordIds.has(e.target_record_id)));
  if (baselineEdges.length !== 11) reject('Prior sample incident edges differ');
  const departments = sorted(state.departments).map(d => ({
    id: d.id, tenant_id: d.tenant_id, custom_object_id: d.custom_object_id, archived_at: d.archived_at,
  }));
  const rows = source.rows.map(row => {
    const data = { ...row.data };
    for (const name of ['staff_group', 'grade', 'legacy_vacancy_reported']) {
      const field = state.fields.find(f => f.custom_object_id === ROW && f.name === name && f.is_active);
      data[name] = exactCanonical(field, data[name]);
    }
    return {
      sourceLine: row.sourceRow,
      identity: digest(JSON.stringify([TENANT, ROW, source.fingerprint, row.sourceRow])),
      departmentId: row.departmentId,
      data,
    };
  });
  return {
    version: 1, tenantId: TENANT, rowObjectId: ROW, surveyObjectId: SURVEY,
    departmentObjectId: DEPARTMENT, sourceSha256: source.fingerprint, reportingYear: source.reportingYear,
    metadata: {
      objects,
      fields: sorted(state.fields.filter(f => relevant.has(f.custom_object_id))),
      definitions: sorted(state.definitions),
    },
    baseline: { records, edges: baselineEdges },
    departments,
    surveys: departments.map(d => ({ departmentId: d.id, data: { survey_name: source.reportingYear } })),
    rows,
  };
}

export function renderInstallSql(template, manifest) {
  const token = '__BNMS_MANIFEST_JSON__';
  if (template.split(token).length !== 2) reject('SQL template must have exactly one manifest token');
  const json = JSON.stringify(manifest);
  if (json.includes('$manifest$')) reject('Unsafe SQL dollar-quote delimiter in manifest');
  // Installation is also gated. The offline CLI never executes this text.
  const commitment = `${SOURCE_SHA}:${digest(json)}`;
  return `-- REVIEW ONLY: installation is a database change, not authorized by preparation.\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '120s';\nDO $approval$ BEGIN\n  IF current_setting('bnms.final_import_approval', true) IS DISTINCT FROM '${commitment}' THEN\n    RAISE EXCEPTION 'Separate final import approval of this exact manifest is required before installation';\n  END IF;\n  IF NOT EXISTS (SELECT 1 FROM public.tenant WHERE id = '${TENANT}' AND name IN ('BNMS','British Nuclear Medicine Society'))\n    OR (SELECT count(*) FROM public.custom_object_definition WHERE tenant_id = '${TENANT}' AND id IN ('${SURVEY}','${ROW}','${DEPARTMENT}') AND status = 'active') <> 3 THEN\n    RAISE EXCEPTION 'Pinned BNMS destination identities are unavailable';\n  END IF;\nEND $approval$;\n${template.replace(token, () => json)}\nCOMMIT;\n`;
}

export function renderInvokeSql() {
  return `-- REVIEW ONLY. Do not execute without separately recorded final import approval.\n-- After approval, an authorized operator sets bnms.final_import_approval to\n-- <source SHA>:<reviewed manifest SHA> in their session. This file does NOT set approval.\n-- Use only the verified destination lvmzliemqnieeoruhkik, never SOURCE/runtime DB.\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '120s';\nSELECT public.import_bnms_workforce_occurrences();\nCOMMIT;\n`;
}

/**
 * Independent offline verifier for replay simulations. Production enforcement
 * lives inside the locked SQL transaction, not in this client-side helper.
 */
export function verifyReplay(manifest, state, ledger) {
  if (!isDeepStrictEqual(ledger.manifest, manifest)) reject('Changed-file or changed-plan replay');
  if (ledger.surveys.length !== 136 || ledger.occurrences.length !== 1242) reject('Partial ledger');
  const records = new Map(state.records.map(r => [r.id, r]));
  const edges = new Map(state.edges.map(e => [e.id, e]));
  const surveyDef = manifest.metadata.definitions.find(d => d.relationship_key === 'workforce_survey_department').id;
  const rowDef = manifest.metadata.definitions.find(d => d.relationship_key === 'workforce_survey_row_survey').id;
  const ids = new Set(), edgeIds = new Set();
  const checkRecord = (id, object, data) => {
    const r = records.get(id);
    if (!r || r.tenant_id !== TENANT || r.custom_object_id !== object || r.archived_at
      || !isDeepStrictEqual(r.data, data) || ids.has(id)) reject('Missing, duplicate, archived or changed record');
    ids.add(id);
  };
  const checkEdge = (id, def, from, to) => {
    const e = edges.get(id);
    if (!e || e.tenant_id !== TENANT || e.relationship_definition_id !== def || e.archived_at
      || e.source_record_id !== from || e.target_record_id !== to
      || !isDeepStrictEqual(e.field_values, {}) || edgeIds.has(id)) reject('Missing, duplicate or changed parent edge');
    edgeIds.add(id);
  };
  const surveyByDepartment = new Map();
  for (const expected of manifest.surveys) {
    const matches = ledger.surveys.filter(s => s.department_id === expected.departmentId);
    if (matches.length !== 1) reject('Ambiguous survey ledger');
    const s = matches[0];
    if (s.tenant_id !== TENANT || s.survey_object_id !== SURVEY || s.source_sha256 !== manifest.sourceSha256
      || s.reporting_year !== manifest.reportingYear || !isDeepStrictEqual(s.data, expected.data)) reject('Survey ledger drift');
    checkRecord(s.survey_id, SURVEY, expected.data);
    checkEdge(s.edge_id, surveyDef, s.survey_id, expected.departmentId);
    surveyByDepartment.set(expected.departmentId, s.survey_id);
  }
  for (const expected of manifest.rows) {
    const matches = ledger.occurrences.filter(o => o.source_line === expected.sourceLine);
    if (matches.length !== 1) reject('Ambiguous occurrence identity');
    const o = matches[0];
    if (o.tenant_id !== TENANT || o.row_object_id !== ROW || o.source_sha256 !== manifest.sourceSha256
      || o.occurrence_identity !== expected.identity || o.department_id !== expected.departmentId
      || o.survey_id !== surveyByDepartment.get(expected.departmentId)
      || !isDeepStrictEqual(o.data, expected.data)) reject('Occurrence or parent ledger drift');
    checkRecord(o.record_id, ROW, expected.data);
    checkEdge(o.edge_id, rowDef, o.record_id, o.survey_id);
  }
  if (state.edges.some(e => (ids.has(e.source_record_id) || ids.has(e.target_record_id)) && !edgeIds.has(e.id))) {
    reject('Unexpected active or historical incident edge');
  }
  const baselineIds = new Set(manifest.baseline.records.map(r => r.id));
  for (const r of manifest.baseline.records) {
    if (!isDeepStrictEqual(records.get(r.id), r)) reject('Prior sample changed');
  }
  const incident = sorted(state.edges.filter(e => baselineIds.has(e.source_record_id) || baselineIds.has(e.target_record_id)));
  if (!isDeepStrictEqual(incident, manifest.baseline.edges)) reject('Prior sample edges changed');
  if (state.records.some(r => r.tenant_id === TENANT && [SURVEY, ROW].includes(r.custom_object_id)
    && !ids.has(r.id) && !baselineIds.has(r.id))) reject('Unprovenanced workforce overlap');
  return { rowsReused: 1242, surveysReused: 136, edgesReused: 1378, writes: 0 };
}