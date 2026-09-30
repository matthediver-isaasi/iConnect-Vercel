/**
 * Offline contract tests for the BNMS workforce preparation plan.
 *
 * The fixture is reconstructed from checked-in validation evidence and the
 * pinned local CSV.  Nothing in this file creates a database client, sends a
 * request, executes SQL, or reads credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPROVED,
  DEPARTMENT,
  SOURCE_SHA,
  buildManifest,
  digest,
  exactCanonical,
  renderInstallSql,
  verifyReplay,
} from './plan.mjs';
import { main as prepare } from './prepare.mjs';
import { FILE, duplicateGroups, parseSource, sourceSummary } from '../workforce-csv-source.mjs';
import { auditSourceAgainstState, resolveOption } from '../workforce-csv-audit.mjs';
import {
  PROJECT,
  ROW,
  SURVEY,
  TENANT,
  stateFingerprint,
} from '../workforce-readonly-state.mjs';

const evidence = JSON.parse(fs.readFileSync(new URL('../../reports/bnms-workforce-validation/live-evidence.json', import.meta.url)));
const validation = JSON.parse(fs.readFileSync(new URL('../../reports/bnms-workforce-validation/validation.json', import.meta.url)));
const sourceBytes = fs.readFileSync(FILE);

/*
 * validation.json contains the source groups, including the department names,
 * while live-evidence.json contains the authoritative object/field/
 * relationship/record/edge observations.  This deliberately mirrors the
 * state shape consumed by buildManifest without depending on /tmp artifacts.
 */
function makeState() {
  const departments = validation.groups.map(group => ({
    id: group.departmentId,
    tenant_id: TENANT,
    custom_object_id: validation.departmentObject.id,
    archived_at: null,
    data: { name: group.departmentName },
  }));
  // The evidence's workforce edge sample also touches three departments that
  // are intentionally outside the pinned CSV.  They are department records
  // in loadState's relevant-object read (but not validation.groups), and must
  // be present for the baseline lineage to validate.
  const knownDepartmentIds = new Set(departments.map(department => department.id));
  const outsideDepartmentRecords = [...new Set(
    evidence.existingWorkforceEdges
      .filter(edge => edge.relationship_definition_id === evidence.relationships.find(
        definition => definition.relationship_key === 'workforce_survey_department',
      ).id)
      .map(edge => edge.target_record_id),
  )].filter(id => !knownDepartmentIds.has(id)).map(id => ({
    id,
    tenant_id: TENANT,
    custom_object_id: validation.departmentObject.id,
    archived_at: null,
    data: { name: `Outside sample ${id}` },
  }));
  return {
    tenant: structuredClone(evidence.tenant),
    objects: structuredClone(evidence.objects),
    fields: structuredClone(evidence.fields),
    definitions: structuredClone(evidence.relationships),
    // loadState includes the department records in its relevant-object
    // record read; the compact live evidence stores them as UUID lookups.
    records: [
      ...structuredClone(evidence.existingWorkforceRecords),
      ...structuredClone(departments),
      ...outsideDepartmentRecords,
    ],
    edges: structuredClone(evidence.existingWorkforceEdges),
    departments,
  };
}

const state = makeState();
const source = parseSource(sourceBytes);
const summary = sourceSummary(source);
const manifest = buildManifest(sourceBytes, state);
const observation = {
  project: evidence.project,
  ...structuredClone(evidence.observation),
};

function fails(fn, pattern) {
  assert.throws(fn, error => {
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function importedStateAndLedger(plan = manifest) {
  const surveyDefinition = plan.metadata.definitions.find(
    definition => definition.relationship_key === 'workforce_survey_department',
  ).id;
  const rowDefinition = plan.metadata.definitions.find(
    definition => definition.relationship_key === 'workforce_survey_row_survey',
  ).id;
  const importedRecords = [];
  const importedEdges = [];
  const surveys = [];
  const occurrences = [];

  for (const expected of plan.surveys) {
    const surveyId = `imported-survey-${expected.departmentId}`;
    const edgeId = `imported-survey-edge-${expected.departmentId}`;
    importedRecords.push({
      id: surveyId,
      tenant_id: TENANT,
      custom_object_id: SURVEY,
      archived_at: null,
      data: structuredClone(expected.data),
    });
    importedEdges.push({
      id: edgeId,
      tenant_id: TENANT,
      relationship_definition_id: surveyDefinition,
      source_record_id: surveyId,
      target_record_id: expected.departmentId,
      archived_at: null,
      field_values: {},
    });
    surveys.push({
      department_id: expected.departmentId,
      survey_id: surveyId,
      edge_id: edgeId,
      tenant_id: TENANT,
      survey_object_id: SURVEY,
      source_sha256: plan.sourceSha256,
      reporting_year: plan.reportingYear,
      data: structuredClone(expected.data),
    });
  }

  const surveyByDepartment = new Map(surveys.map(survey => [survey.department_id, survey]));
  for (const expected of plan.rows) {
    const parent = surveyByDepartment.get(expected.departmentId);
    const recordId = `imported-row-${expected.identity}`;
    const edgeId = `imported-row-edge-${expected.identity}`;
    importedRecords.push({
      id: recordId,
      tenant_id: TENANT,
      custom_object_id: ROW,
      archived_at: null,
      data: structuredClone(expected.data),
    });
    importedEdges.push({
      id: edgeId,
      tenant_id: TENANT,
      relationship_definition_id: rowDefinition,
      source_record_id: recordId,
      target_record_id: parent.survey_id,
      archived_at: null,
      field_values: {},
    });
    occurrences.push({
      source_line: expected.sourceLine,
      occurrence_identity: expected.identity,
      department_id: expected.departmentId,
      survey_id: parent.survey_id,
      record_id: recordId,
      edge_id: edgeId,
      tenant_id: TENANT,
      row_object_id: ROW,
      source_sha256: plan.sourceSha256,
      data: structuredClone(expected.data),
    });
  }

  return {
    state: {
      ...structuredClone(state),
      records: [...structuredClone(state.records), ...importedRecords],
      edges: [...structuredClone(state.edges), ...importedEdges],
    },
    ledger: { manifest: plan, surveys, occurrences },
  };
}

test('pinned source totals, approved transformation, and duplicate occurrence identity', () => {
  assert.equal(source.fingerprint, SOURCE_SHA);
  assert.equal(summary.reportingYear, '2025/26');
  assert.equal(summary.totalRows, 1242);
  assert.equal(summary.totalDepartments, 136);
  assert.equal(summary.totalOccupiedHundredths, 170814);
  assert.equal(summary.totalOccupiedWte, 1708.14);
  assert.deepEqual(summary.normalizedVacancyCounts, { Yes: 101, No: 1141 });
  assert.deepEqual(summary.originalVacancyCounts, { '': 53, Yes: 101, No: 1088 });
  assert.deepEqual(summary.exactDuplicates.normalized, { groups: 84, rows: 216, beyondFirst: 132 });
  assert.deepEqual(summary.exactDuplicates.original, { groups: 82, rows: 210, beyondFirst: 128 });
  assert.deepEqual(summary.alternativeExactDedupTotals.normalized, {
    rows: 1110,
    occupiedHundredths: 159639,
    occupiedWte: 1596.39,
  });
  assert.equal(manifest.rows.length, 1242);
  assert.equal(manifest.surveys.length, 136);
  assert.equal(manifest.departments.length, 136);
  assert.deepEqual(APPROVED, {
    duplicates: 'preserve_all',
    mapping: 'report-exact-canonical',
    blankVacancy: 'No',
    vacantWte: 'omit',
    liveImportAuthorized: false,
  });
  assert.ok(manifest.rows.every(row => !Object.hasOwn(row.data, 'vacant_wte')));

  const duplicate = duplicateGroups(source.rows, 'normalized').find(group => group.rows.length > 1);
  assert.ok(duplicate, 'the pinned source must contain an exact duplicate group');
  const duplicateLines = new Set(duplicate.sourceRows);
  const duplicateIdentities = manifest.rows
    .filter(row => duplicateLines.has(row.sourceLine))
    .map(row => row.identity);
  assert.equal(new Set(duplicateIdentities).size, duplicateIdentities.length);
  assert.equal(duplicateIdentities.length, duplicate.rows.length);
  const duplicateData = manifest.rows
    .filter(row => duplicateLines.has(row.sourceLine))
    .map(row => row.data);
  assert.equal(new Set(duplicateData.map(data => JSON.stringify(data))).size, 1);
  assert.equal(duplicateData[0].staff_group, 'Clinical Practitioner – Technologist ');
});

test('canonical options preserve exact live whitespace, blank vacancy becomes No, and unknown/ambiguous options fail', () => {
  const staffField = state.fields.find(field => field.custom_object_id === ROW && field.name === 'staff_group');
  const gradeField = state.fields.find(field => field.custom_object_id === ROW && field.name === 'grade');
  const vacancyField = state.fields.find(field => field.custom_object_id === ROW && field.name === 'legacy_vacancy_reported');
  assert.equal(exactCanonical(staffField, ' Clinical Practitioner – Technologist '), 'Clinical Practitioner – Technologist ');
  assert.equal(exactCanonical(gradeField, ' Fellow '), 'Fellow ');
  assert.equal(exactCanonical(vacancyField, 'no'), 'No');
  assert.equal(source.rows.filter(row => row.originalLegacy === '').length, 53);
  assert.equal(source.rows.filter(row => row.originalLegacy === '' && row.data.legacy_vacancy_reported === 'No').length, 53);

  fails(() => exactCanonical(gradeField, 'Band 99'), /Unsupported live option/);
  const ambiguous = { options: [{ label: 'Band X', value: 'Band X' }, { label: 'Band X', value: 'Band Y' }] };
  assert.deepEqual(resolveOption(ambiguous, 'Band X'), { error: 'Ambiguous live options' });
  fails(() => exactCanonical(ambiguous, 'Band X'), /Ambiguous live options/);
});

test('changed bytes and reordered bytes cannot produce a manifest', () => {
  const changed = Buffer.from(sourceBytes);
  changed[changed.length - 1] = changed[changed.length - 1] === 10 ? 9 : changed[changed.length - 1] ^ 1;
  fails(() => buildManifest(changed, state), /source fingerprint mismatch/);

  const lines = sourceBytes.toString('binary').split('\r\n');
  [lines[1], lines[2]] = [lines[2], lines[1]];
  fails(() => buildManifest(Buffer.from(lines.join('\r\n'), 'binary'), state), /source fingerprint mismatch/);
});

test('metadata drift fails closed, including missing Band 8d', () => {
  const missingBand8d = structuredClone(state);
  const grade = missingBand8d.fields.find(field => field.custom_object_id === ROW && field.name === 'grade');
  grade.options = grade.options.filter(option => option.value !== 'Band 8d');
  const audit = auditSourceAgainstState(source, missingBand8d);
  assert.ok(audit.blockers.some(blocker => blocker.code === 'OPTION' && blocker.supplied === 'Band 8d'));
  fails(() => buildManifest(sourceBytes, missingBand8d), /OPTION:/);

  const inactiveObject = structuredClone(state);
  inactiveObject.objects.find(object => object.id === DEPARTMENT).status = 'archived';
  fails(() => buildManifest(sourceBytes, inactiveObject), /DEPARTMENT_OBJECT|DEPARTMENT object/);
});

test('foreign and archived departments, plus active and historical survey overlaps, are rejected', () => {
  const departmentId = manifest.rows[0].departmentId;
  for (const [label, mutate, expected] of [
    ['foreign', department => { department.tenant_id = 'foreign-tenant'; }, 'cross-tenant'],
    ['archived', department => { department.archived_at = '2026-01-01T00:00:00Z'; }, 'archived'],
  ]) {
    const altered = structuredClone(state);
    mutate(altered.departments.find(department => department.id === departmentId));
    const audit = auditSourceAgainstState(source, altered);
    assert.ok(audit.blockers.some(blocker => blocker.code === 'DEPARTMENT' && blocker.message === expected), label);
    fails(() => buildManifest(sourceBytes, altered), /Existing workforce baseline|DEPARTMENT/);
  }

  for (const archived_at of [null, '2026-01-01T00:00:00Z']) {
    const altered = structuredClone(state);
    const surveyId = archived_at ? 'historical-overlap-survey' : 'active-overlap-survey';
    altered.records.push({
      id: surveyId,
      tenant_id: TENANT,
      custom_object_id: SURVEY,
      archived_at,
      data: { survey_name: '2025/26' },
    });
    altered.edges.push({
      id: `${surveyId}-edge`,
      tenant_id: TENANT,
      relationship_definition_id: altered.definitions.find(
        definition => definition.relationship_key === 'workforce_survey_department',
      ).id,
      source_record_id: surveyId,
      target_record_id: departmentId,
      archived_at,
      field_values: {},
    });
    const audit = auditSourceAgainstState(source, altered);
    if (archived_at) {
      assert.ok(audit.blockers.some(blocker => blocker.code === 'SURVEY_MATCH'), 'historical');
    } else {
      // A single active overlap is a possible reuse in the audit, but it is
      // still outside the approved first-import baseline and must fail the
      // plan's exact active-record count.
      assert.equal(audit.counts.existingActiveSurveys, 4);
    }
    fails(() => buildManifest(sourceBytes, altered), /Existing workforce baseline|SURVEY_MATCH/);
  }
});

test('verifyReplay accepts the complete simulated no-op rerun', () => {
  const simulated = importedStateAndLedger();
  assert.deepEqual(verifyReplay(manifest, simulated.state, simulated.ledger), {
    rowsReused: 1242,
    surveysReused: 136,
    edgesReused: 1378,
    writes: 0,
  });
});

test('verifyReplay rejects changed manifest/file, changed data, lost row, and duplicate identity', () => {
  const simulated = importedStateAndLedger();
  const changedManifest = structuredClone(manifest);
  changedManifest.sourceSha256 = 'changed-file-sha';
  fails(() => verifyReplay(changedManifest, simulated.state, simulated.ledger), /Changed-file/);

  const changedData = structuredClone(simulated.ledger);
  changedData.occurrences[0].data.occupied_wte += 1;
  fails(() => verifyReplay(manifest, simulated.state, changedData), /Occurrence or parent ledger drift/);

  const lostRow = structuredClone(simulated.ledger);
  lostRow.occurrences.pop();
  fails(() => verifyReplay(manifest, simulated.state, lostRow), /Partial ledger/);

  const duplicateIdentity = structuredClone(simulated.ledger);
  duplicateIdentity.occurrences.pop();
  duplicateIdentity.occurrences.push(structuredClone(duplicateIdentity.occurrences[0]));
  fails(() => verifyReplay(manifest, simulated.state, duplicateIdentity), /Ambiguous occurrence identity/);
});

test('verifyReplay rejects misparented edge and occurrence, archived records/edges, and direct extra edges', () => {
  const misparented = importedStateAndLedger();
  const first = misparented.ledger.occurrences[0];
  const other = misparented.ledger.surveys.find(survey => survey.department_id !== first.department_id);
  first.department_id = other.department_id;
  first.survey_id = other.survey_id;
  misparented.state.edges.find(edge => edge.id === first.edge_id).target_record_id = other.survey_id;
  fails(() => verifyReplay(manifest, misparented.state, misparented.ledger), /Occurrence or parent ledger drift/);

  const archivedRecord = importedStateAndLedger();
  const record = archivedRecord.state.records.find(item => item.id === archivedRecord.ledger.occurrences[0].record_id);
  record.archived_at = '2026-01-01T00:00:00Z';
  fails(() => verifyReplay(manifest, archivedRecord.state, archivedRecord.ledger), /Missing, duplicate, archived/);

  const archivedEdge = importedStateAndLedger();
  const edge = archivedEdge.state.edges.find(item => item.id === archivedEdge.ledger.occurrences[0].edge_id);
  edge.archived_at = '2026-01-01T00:00:00Z';
  fails(() => verifyReplay(manifest, archivedEdge.state, archivedEdge.ledger), /Missing, duplicate or changed parent edge/);

  const changedRowEdgeFields = importedStateAndLedger();
  const rowEdge = changedRowEdgeFields.state.edges.find(
    item => item.id === changedRowEdgeFields.ledger.occurrences[0].edge_id,
  );
  rowEdge.field_values = { imported_by: 'unexpected' };
  fails(() => verifyReplay(manifest, changedRowEdgeFields.state, changedRowEdgeFields.ledger), /Missing, duplicate or changed parent edge/);

  const changedSurveyEdgeFields = importedStateAndLedger();
  const surveyEdge = changedSurveyEdgeFields.state.edges.find(
    item => item.id === changedSurveyEdgeFields.ledger.surveys[0].edge_id,
  );
  surveyEdge.field_values = { imported_by: 'unexpected' };
  fails(() => verifyReplay(manifest, changedSurveyEdgeFields.state, changedSurveyEdgeFields.ledger), /Missing, duplicate or changed parent edge/);

  const directEdge = importedStateAndLedger();
  const occurrence = directEdge.ledger.occurrences[0];
  directEdge.state.edges.push({
    id: 'unexpected-direct-department-edge',
    tenant_id: TENANT,
    relationship_definition_id: 'direct-row-department-definition',
    source_record_id: occurrence.record_id,
    target_record_id: occurrence.department_id,
    archived_at: null,
    field_values: {},
  });
  fails(() => verifyReplay(manifest, directEdge.state, directEdge.ledger), /Unexpected active or historical incident edge/);
});

test('verifyReplay rejects partial ledgers, prior sample mutation, and unprovenanced records', () => {
  const partial = importedStateAndLedger();
  partial.ledger.surveys.pop();
  fails(() => verifyReplay(manifest, partial.state, partial.ledger), /Partial ledger/);

  const priorMutation = importedStateAndLedger();
  priorMutation.state.records.find(record => record.id === manifest.baseline.records[0].id).data.survey_name = 'mutated';
  fails(() => verifyReplay(manifest, priorMutation.state, priorMutation.ledger), /Prior sample changed/);

  const extra = importedStateAndLedger();
  extra.state.records.push({
    id: 'unprovenanced-workforce-record',
    tenant_id: TENANT,
    custom_object_id: ROW,
    archived_at: null,
    data: { row_name: '2025/26', staff_group: 'Nurse', grade: 'Band 1', occupied_wte: 0, legacy_vacancy_reported: 'No' },
  });
  fails(() => verifyReplay(manifest, extra.state, extra.ledger), /Unprovenanced workforce overlap/);
});

test('install renderer requires one token, preserves literal dollar signs, and rejects delimiter injection', () => {
  const literalManifest = { marker: '$& should remain literal', nested: { value: '$1' } };
  const rendered = renderInstallSql('SELECT $manifest$__BNMS_MANIFEST_JSON__$manifest$ AS payload;\n', literalManifest);
  const expectedCommitment = `${SOURCE_SHA}:${digest(JSON.stringify(literalManifest))}`;
  assert.match(rendered, new RegExp(`IS DISTINCT FROM '${expectedCommitment}'`));
  assert.equal((rendered.match(/__BNMS_MANIFEST_JSON__/g) || []).length, 0);
  assert.match(rendered, /\$& should remain literal/);
  assert.match(rendered, /\$1/);
  fails(() => renderInstallSql('SELECT 1;', manifest), /exactly one manifest token/);
  fails(() => renderInstallSql('__BNMS_MANIFEST_JSON__ __BNMS_MANIFEST_JSON__', manifest), /exactly one manifest token/);
  fails(() => renderInstallSql('__BNMS_MANIFEST_JSON__', { value: '$manifest$' }), /dollar-quote delimiter/);
});

test('distinct same-department payload swaps produce distinct approval commitments with the same source SHA', () => {
  const sameDepartment = manifest.rows.filter(row => row.departmentId === manifest.rows[0].departmentId);
  const first = sameDepartment.find(row => JSON.stringify(row.data) !== JSON.stringify(sameDepartment[0].data));
  assert.ok(first, 'fixture needs two distinct payloads in one department');
  const second = sameDepartment[0];
  const swapped = structuredClone(manifest);
  const firstIndex = swapped.rows.findIndex(row => row.sourceLine === first.sourceLine);
  const secondIndex = swapped.rows.findIndex(row => row.sourceLine === second.sourceLine);
  [swapped.rows[firstIndex].data, swapped.rows[secondIndex].data] =
    [swapped.rows[secondIndex].data, swapped.rows[firstIndex].data];
  assert.equal(swapped.sourceSha256, manifest.sourceSha256);
  const originalManifestSha = digest(JSON.stringify(manifest));
  const swappedManifestSha = digest(JSON.stringify(swapped));
  assert.notEqual(swappedManifestSha, originalManifestSha);
  const template = '$manifest$__BNMS_MANIFEST_JSON__$manifest$';
  const originalSql = renderInstallSql(template, manifest);
  const swappedSql = renderInstallSql(template, swapped);
  assert.match(originalSql, new RegExp(`IS DISTINCT FROM '${SOURCE_SHA}:${originalManifestSha}'`));
  assert.match(swappedSql, new RegExp(`IS DISTINCT FROM '${SOURCE_SHA}:${swappedManifestSha}'`));
  assert.notEqual(originalSql, swappedSql);
});

test('prepare CLI rejects --apply before reading any input and produces review-only artifacts offline', () => {
  fails(
    () => prepare(['--apply', 'missing-state.json', 'missing-observation.json', 'missing-output']),
    /--apply is forbidden/,
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bnms-plan-test-'));
  const statePath = path.join(directory, 'state.json');
  const observationPath = path.join(directory, 'observation.json');
  const outputPath = path.join(directory, 'review');
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(observationPath, JSON.stringify({
    ...observation,
    secondPassPagination: structuredClone(evidence.pagination),
    fingerprint: stateFingerprint(state),
  }));
  const review = prepare([statePath, observationPath, outputPath]);
  assert.equal(review.status, 'PREPARED_FOR_REVIEW_NOT_AUTHORIZED');
  assert.equal(review.summary.surveys, 136);
  assert.equal(review.summary.occurrences, 1242);
  assert.equal(review.verification.sqlExecuted, false);
  const manifestFile = fs.readFileSync(path.join(outputPath, 'manifest.json'), 'utf8');
  assert.equal(review.manifestSha256, digest(manifestFile));
  assert.equal(manifestFile, JSON.stringify(JSON.parse(manifestFile)));
  assert.equal(manifestFile.endsWith('\n'), false);
  assert.match(
    fs.readFileSync(path.join(outputPath, 'install.review-only.sql'), 'utf8'),
    new RegExp(`IS DISTINCT FROM '${SOURCE_SHA}:${review.manifestSha256}'`),
  );
  for (const filename of ['manifest.json', 'review.json', 'install.review-only.sql', 'invoke.review-only.sql', 'report.html']) {
    assert.ok(fs.existsSync(path.join(outputPath, filename)), filename);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('prepare observation must be two complete stable matching passes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bnms-observation-test-'));
  const statePath = path.join(directory, 'state.json');
  const observationPath = path.join(directory, 'observation.json');
  fs.writeFileSync(statePath, JSON.stringify(state));
  const incomplete = {
    ...observation,
    fingerprint: stateFingerprint(state),
    completePasses: 1,
  };
  fs.writeFileSync(observationPath, JSON.stringify(incomplete));
  fails(() => prepare([statePath, observationPath, path.join(directory, 'review')]), /Complete matching destination GET evidence/);
  fs.rmSync(directory, { recursive: true, force: true });
});