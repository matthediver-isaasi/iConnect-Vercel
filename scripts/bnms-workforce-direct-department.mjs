#!/usr/bin/env node
/**
 * BNMS workforce graph simplification (review-first).
 *
 * This script has deliberately been kept independent of the current-set
 * migration.  It only reads through DEST_DATABASE_URL during a dry run.  A
 * write is possible only with --apply and a separately reviewed report whose
 * fingerprint still describes the destination.
 *
 *   node scripts/bnms-workforce-direct-department.mjs --report=.local/reports/workforce-direct.json
 *   node scripts/bnms-workforce-direct-department.mjs --apply \
 *     --review=.local/reports/workforce-direct.json \
 *     --report=.local/reports/workforce-direct-applied.json
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const DEPARTMENT_OBJECT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
export const SURVEY_OBJECT_ID = '931df885-c3b7-449a-b206-eef31fb9e883';
export const ROW_OBJECT_ID = 'bf123bdb-7227-4f45-b5f9-8344d0f65446';
export const OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID = 'ab296a40-f032-4a3b-8155-108636a2cfc3';
export const OLD_ROW_SURVEY_RELATIONSHIP_ID = '749598f1-e2e8-4fc9-b5f4-fb5d8af53f3c';
export const NEW_RELATIONSHIP_ID = 'a422da51-6005-4831-a69e-bf284ff6f124';
export const NEW_RELATIONSHIP_KEY = 'workforce_survey_row_department';
export const EXPECTED_ACTIVE_ROWS = 8;
export const EXPECTED_ACTIVE_SURVEYS = 3;
export const EXPECTED_OLD_EDGES = EXPECTED_ACTIVE_ROWS + EXPECTED_ACTIVE_SURVEYS;
export const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const DESTINATION_PROJECT_SUFFIX = '.lvmzliemqnieeoruhkik';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_DEFINITION_IDS = new Set([
  OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID,
  OLD_ROW_SURVEY_RELATIONSHIP_ID,
]);
const PINNED_OBJECT_IDS = new Set([DEPARTMENT_OBJECT_ID, SURVEY_OBJECT_ID, ROW_OBJECT_ID]);
const fail = (message) => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const active = (row) => row && row.archived_at == null
  && (row.status === undefined || row.status === null || row.status === 'active');
const clone = (value) => value == null ? value : structuredClone(value);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function byId(rows = []) {
  const result = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    if (result.has(row.id)) fail(`Duplicate destination id ${row.id}.`);
    result.set(row.id, row);
  }
  return result;
}

function endpoint(definition, side) {
  return side === 'source' ? definition?.source_custom_object_id : definition?.target_custom_object_id;
}

function containsId(value, id) {
  return JSON.stringify(value ?? null).includes(id);
}

/**
 * Replace exactly the Workforce & Equipment target relationship element.
 * The clone is intentionally changed at one path only; card order, unknown
 * keys, and every other JSON value are retained byte-for-byte by JSON shape.
 */
export function replaceDepartmentLayout(configuration, oldRelationshipId = OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID,
  newRelationshipId = NEW_RELATIONSHIP_ID) {
  const output = clone(configuration);
  const cards = output?.views?.detail?.cards;
  check(Array.isArray(cards), 'Department detail presentation cards are missing.');
  const definitionIdFor = field =>
    field?.definitionId ?? field?.definition_id ?? field?.relationship_definition_id;
  const candidates = [];
  for (const [cardIndex, card] of cards.entries()) {
    if (card?.title !== 'Workforce & Equipment' || !Array.isArray(card.fields)) continue;
    for (const [fieldIndex, field] of card.fields.entries()) {
      if (field?.type === 'relationship'
        && definitionIdFor(field) === oldRelationshipId
        && field.side === 'target') {
        candidates.push({ cardIndex, fieldIndex, field });
      }
    }
  }
  const alreadyNew = cards.flatMap((card) => card?.title === 'Workforce & Equipment' && Array.isArray(card.fields)
    ? card.fields.filter((field) => field?.type === 'relationship'
      && definitionIdFor(field) === newRelationshipId && field.side === 'target')
    : []);
  if (!candidates.length) {
    check(alreadyNew.length === 1, 'Workforce & Equipment card has neither the old nor the new target relationship.');
    check(!containsId(output.views.detail.cards, oldRelationshipId),
      'Department layout still contains an unsupported old relationship reference.');
    return { configuration: output, changed: false, location: null };
  }
  check(candidates.length === 1, 'Workforce & Equipment card has an ambiguous old target relationship.');
  check(alreadyNew.length === 0, 'Department layout contains both old and new workforce target relationships.');
  const location = candidates[0];
  const field = output.views.detail.cards[location.cardIndex].fields[location.fieldIndex];
  check(field.columnIndex === 0, 'Workforce & Equipment old workforce relationship is not in target column 0.');
  for (const key of ['definitionId', 'definition_id', 'relationship_definition_id']) {
    if (Object.hasOwn(field, key)) field[key] = newRelationshipId;
  }
  field.id = `relationship:${newRelationshipId}:target`;
  check(!containsId(output.views.detail.cards, oldRelationshipId),
    'Department layout contains another unsupported old relationship reference.');
  return { configuration: output, changed: true, location };
}

function expectedNewDefinition(oldRowDefinition) {
  return {
    id: NEW_RELATIONSHIP_ID,
    tenant_id: TENANT_ID,
    relationship_key: NEW_RELATIONSHIP_KEY,
    source_kind: 'custom_object',
    source_custom_object_id: ROW_OBJECT_ID,
    target_kind: 'custom_object',
    target_custom_object_id: DEPARTMENT_OBJECT_ID,
    cardinality: 'many_to_one',
    source_label: 'Organisation department',
    target_label: 'Workforce Register',
    is_required: true,
    show_on_source: true,
    show_on_target: true,
    edit_from_source: true,
    edit_from_target: true,
    status: 'active',
    // Preserve the old row relationship's dedicated configuration, if any.
    configuration: clone(oldRowDefinition?.configuration ?? {}),
  };
}

function definitionMatchesNew(definition, oldRowDefinition = null) {
  if (!definition) return false;
  const desired = expectedNewDefinition(oldRowDefinition || definition);
  return Object.entries(desired).every(([key, value]) => fingerprint(definition[key]) === fingerprint(value));
}

function relevantScope(state) {
  return {
    tenant_id: state.tenantId,
    objects: (state.objects || []).filter((row) => PINNED_OBJECT_IDS.has(row.id))
      .map(({ id, tenant_id, object_key, status, archived_at, primary_display_field_id, configuration }) =>
        ({ id, tenant_id, object_key, status, archived_at, primary_display_field_id, configuration })),
    definitions: (state.definitions || [])
      .filter((row) => PINNED_OBJECT_IDS.has(row.source_custom_object_id)
        || PINNED_OBJECT_IDS.has(row.target_custom_object_id)
        || OLD_DEFINITION_IDS.has(row.id) || row.id === NEW_RELATIONSHIP_ID)
      .map(({ id, tenant_id, relationship_key, source_kind, source_custom_object_id, target_kind,
        target_custom_object_id, cardinality, source_label, target_label, is_required, show_on_source,
        show_on_target, edit_from_source, edit_from_target, status, archived_at, configuration }) =>
        ({ id, tenant_id, relationship_key, source_kind, source_custom_object_id, target_kind,
          target_custom_object_id, cardinality, source_label, target_label, is_required, show_on_source,
          show_on_target, edit_from_source, edit_from_target, status, archived_at, configuration })),
    records: (state.records || []).filter((row) => PINNED_OBJECT_IDS.has(row.custom_object_id))
      .map(({ id, tenant_id, custom_object_id, archived_at, data }) =>
        ({ id, tenant_id, custom_object_id, archived_at, data })),
    edges: (state.edges || []).map(({ id, tenant_id, relationship_definition_id, source_record_id,
      target_record_id, archived_at, field_values }) =>
      ({ id, tenant_id, relationship_definition_id, source_record_id, target_record_id, archived_at, field_values })),
    departmentConfiguration: state.departmentConfiguration,
    formReferences: state.formReferences || [],
    reportReferences: state.reportReferences || [],
    auditHistory: state.auditHistory || [],
    reportExportReferences: state.reportExportReferences || [],
    unsupportedReferences: state.unsupportedReferences || [],
    relationshipPermissions: state.relationshipPermissions || [],
    access: {
      objectGrants: state.objectGrants || [],
      fieldGrants: state.fieldGrants || [],
    },
  };
}

function assertTenantScope(state) {
  check(state.tenantId === TENANT_ID, 'Pinned BNMS tenant scope is missing or drifted.');
  for (const row of [...(state.objects || []), ...(state.definitions || []), ...(state.records || []), ...(state.edges || [])]) {
    check(row.tenant_id === TENANT_ID, `Cross-tenant graph row ${row.id} was returned; refusing migration.`);
  }
}

/**
 * Pure graph planner. It performs no I/O and returns only identifiers/counts
 * in its mutation plan. The state shape is intentionally plain so this can be
 * exercised with small stubs without a database.
 */
export function buildPlan(state, { strictLiveCounts = false } = {}) {
  assertTenantScope(state);
  const objects = byId(state.objects);
  const definitions = byId(state.definitions);
  const records = byId(state.records);
  const edges = state.edges || [];
  const department = objects.get(DEPARTMENT_OBJECT_ID);
  const surveyObject = objects.get(SURVEY_OBJECT_ID);
  const rowObject = objects.get(ROW_OBJECT_ID);
  check(department?.tenant_id === TENANT_ID && department.object_key === 'org_department',
    'Pinned Department object is missing or drifted.');
  check(surveyObject?.tenant_id === TENANT_ID && surveyObject.object_key === 'workforce_survey',
    'Pinned workforce_survey object is missing or drifted.');
  check(rowObject?.tenant_id === TENANT_ID && rowObject.object_key === 'workforce_survey_row',
    'Pinned workforce_survey_row object is missing or drifted.');
  check(rowObject.primary_display_field_id === state.rowPrimaryDisplayFieldId
    || state.rowPrimaryDisplayFieldId === undefined,
  'workforce_survey_row primary display field changed.');

  const surveyDepartment = definitions.get(OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID);
  const rowSurvey = definitions.get(OLD_ROW_SURVEY_RELATIONSHIP_ID);
  check(surveyDepartment && surveyDepartment.tenant_id === TENANT_ID
    && surveyDepartment.source_custom_object_id === SURVEY_OBJECT_ID
    && surveyDepartment.target_custom_object_id === DEPARTMENT_OBJECT_ID,
  'Pinned workforce survey-to-Department relationship is missing or drifted.');
  check(rowSurvey && rowSurvey.tenant_id === TENANT_ID
    && rowSurvey.source_custom_object_id === ROW_OBJECT_ID
    && rowSurvey.target_custom_object_id === SURVEY_OBJECT_ID,
  'Pinned workforce row-to-survey relationship is missing or drifted.');
  check(rowSurvey.show_on_source === true && rowSurvey.show_on_target === true
    && rowSurvey.edit_from_source === true && rowSurvey.edit_from_target === true,
  'Pinned workforce row-to-survey visibility/edit metadata drifted.');
  check(Array.isArray(rowSurvey.configuration?.relationship_fields)
    ? rowSurvey.configuration.relationship_fields.length === 0
    : rowSurvey.configuration?.relationship_fields === undefined,
  'Pinned workforce row-to-survey relationship fields are not empty.');
  check(surveyDepartment.show_on_source === true && surveyDepartment.show_on_target === true
    && surveyDepartment.edit_from_source === true && surveyDepartment.edit_from_target === false,
  'Pinned workforce survey-to-Department visibility/edit metadata drifted.');

  const newDefinition = definitions.get(NEW_RELATIONSHIP_ID);
  const sameNewDefinition = definitionMatchesNew(newDefinition, rowSurvey);
  if (newDefinition) {
    check(sameNewDefinition, 'New workforce Department relationship ID is already used by different metadata.');
    check(newDefinition.relationship_key === NEW_RELATIONSHIP_KEY,
      'New workforce Department relationship key is already used by different metadata.');
  }
  const keyCollision = (state.definitions || []).find((definition) =>
    definition.relationship_key === NEW_RELATIONSHIP_KEY && definition.id !== NEW_RELATIONSHIP_ID);
  check(!keyCollision, 'New workforce Department relationship key already exists under another ID.');

  const activeOldSurveyDepartmentEdges = edges.filter((edge) =>
    edge.relationship_definition_id === OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID && active(edge));
  const activeOldRowSurveyEdges = edges.filter((edge) =>
    edge.relationship_definition_id === OLD_ROW_SURVEY_RELATIONSHIP_ID && active(edge));
  for (const edge of [...activeOldSurveyDepartmentEdges, ...activeOldRowSurveyEdges]) {
    check(edge.field_values == null || fingerprint(edge.field_values) === fingerprint({}),
      `Legacy workforce edge ${edge.id} contains unsupported field values.`);
  }
  const activeRows = (state.records || []).filter((record) =>
    record.custom_object_id === ROW_OBJECT_ID && active(record));
  const activeSurveys = (state.records || []).filter((record) =>
    record.custom_object_id === SURVEY_OBJECT_ID && active(record));
  const recordFor = (id) => records.get(id);
  const departmentByRow = new Map();
  const oldEdgeIds = [];
  const activeNewEdges = edges.filter((edge) =>
    edge.relationship_definition_id === NEW_RELATIONSHIP_ID && active(edge));
  const completedGraphCandidate = !!newDefinition
    && sameNewDefinition
    && !activeOldSurveyDepartmentEdges.length
    && !activeOldRowSurveyEdges.length
    && !active(surveyObject)
    && !active(surveyDepartment)
    && !active(rowSurvey);
  if (strictLiveCounts) {
    check(activeRows.length === EXPECTED_ACTIVE_ROWS, `Expected ${EXPECTED_ACTIVE_ROWS} active workforce rows.`);
    if (!completedGraphCandidate) {
      check(activeSurveys.length === EXPECTED_ACTIVE_SURVEYS, `Expected ${EXPECTED_ACTIVE_SURVEYS} active workforce surveys.`);
      check(activeOldRowSurveyEdges.length + activeOldSurveyDepartmentEdges.length === EXPECTED_OLD_EDGES,
        `Expected ${EXPECTED_OLD_EDGES} active legacy workforce edges.`);
    }
  }
  // Every active survey is a parent record to be archived. Validate the
  // complete survey set first, including a survey which happens not to have a
  // current row, rather than silently leaving an old edge behind.
  const surveyDepartments = new Map();
  let surveyIdsToArchive;
  if (completedGraphCandidate) {
    for (const row of activeRows) {
      const direct = activeNewEdges.filter((edge) => edge.source_record_id === row.id);
      check(direct.length === 1, `Completed workforce row ${row.id} does not have exactly one direct Department.`);
      const target = recordFor(direct[0].target_record_id);
      check(target?.tenant_id === TENANT_ID && target.custom_object_id === DEPARTMENT_OBJECT_ID
        && active(target), `Completed workforce row ${row.id} resolves outside the active Department scope.`);
      departmentByRow.set(row.id, target.id);
    }
    check(activeNewEdges.length === activeRows.length,
      'Completed workforce graph has extra direct Department edges.');
    surveyIdsToArchive = [];
  } else {
    for (const survey of activeSurveys) {
      const departments = activeOldSurveyDepartmentEdges.filter((edge) =>
        edge.source_record_id === survey.id);
      check(departments.length === 1, `Workforce survey ${survey.id} has missing or multiple Department parents.`);
      const departmentEdge = departments[0];
      const target = recordFor(departmentEdge.target_record_id);
      check(target?.tenant_id === TENANT_ID && target.custom_object_id === DEPARTMENT_OBJECT_ID
        && active(target), `Workforce survey ${survey.id} resolves outside the active Department scope.`);
      surveyDepartments.set(survey.id, { edge: departmentEdge, targetId: target.id });
      oldEdgeIds.push(departmentEdge.id);
    }
  check(new Set([...surveyDepartments.values()].map((item) => item.targetId)).size === activeSurveys.length,
      'Active workforce surveys do not resolve to distinct Departments.');
    if (strictLiveCounts) {
      check(surveyDepartments.size === EXPECTED_ACTIVE_SURVEYS
        && new Set([...surveyDepartments.values()].map((item) => item.targetId)).size === EXPECTED_ACTIVE_SURVEYS,
      'The three active workforce surveys must each resolve to a distinct Department.');
    }
    surveyIdsToArchive = activeSurveys.map((survey) => survey.id);
    for (const row of activeRows) {
      const parents = activeOldRowSurveyEdges.filter((edge) => edge.source_record_id === row.id);
      check(parents.length === 1, `Workforce row ${row.id} does not resolve to exactly one active survey.`);
      const survey = recordFor(parents[0].target_record_id);
      check(survey?.custom_object_id === SURVEY_OBJECT_ID && active(survey),
        `Workforce row ${row.id} resolves outside the active workforce survey scope.`);
      const department = surveyDepartments.get(survey.id);
      check(department, `Workforce survey ${survey.id} is not in the validated active survey set.`);
      departmentByRow.set(row.id, department.targetId);
      oldEdgeIds.push(parents[0].id);
    }
  }

  // Any active edge involving the survey object must be one of the two pinned
  // definitions. This catches an unreviewed form/report relationship before
  // metadata is archived.
  const touchingSurveyDefinitions = (state.definitions || []).filter((definition) =>
    definition.tenant_id === TENANT_ID
      && (definition.source_custom_object_id === SURVEY_OBJECT_ID
        || definition.target_custom_object_id === SURVEY_OBJECT_ID));
  const unexpectedActiveEdges = edges.filter((edge) => active(edge)
    && touchingSurveyDefinitions.some((definition) => definition.id === edge.relationship_definition_id)
    && !OLD_DEFINITION_IDS.has(edge.relationship_definition_id));
  check(!unexpectedActiveEdges.length,
    'Unexpected active relationship edges touch workforce_survey; unsupported migration required.');

  const refs = [
    ...(state.formReferences || []),
    ...(state.reportReferences || []),
    ...(state.reportExportReferences || []),
    ...(state.unsupportedReferences || []),
  ];
  check(!refs.length, 'Forms, reports, or configurations reference obsolete workforce metadata.');

  const layout = replaceDepartmentLayout(
    state.departmentConfiguration ?? department.configuration,
    OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID,
    NEW_RELATIONSHIP_ID,
  );

  // A completed replay is a successful no-op only when every row already has
  // exactly one direct Department edge and the legacy graph is archived.
  const completed = !!newDefinition
    && sameNewDefinition
    && !activeOldSurveyDepartmentEdges.length
    && !activeOldRowSurveyEdges.length
    && surveyIdsToArchive.every((id) => !active(recordFor(id)))
    && activeRows.every((row) => {
      const direct = activeNewEdges.filter((edge) => edge.source_record_id === row.id);
      return direct.length === 1 && direct[0].target_record_id === departmentByRow.get(row.id);
    })
    && activeNewEdges.length === activeRows.length
    && layout.changed === false;
  if (completed) {
    return {
      completed: true,
      changed: false,
      newDefinition: null,
      newEdges: [],
      archiveEdgeIds: [],
      archiveSurveyIds: [],
      archiveDefinitionIds: [],
      archiveObjectId: null,
      departmentConfiguration: layout.configuration,
      departmentByRow: Object.fromEntries(departmentByRow),
      summary: { activeRows: activeRows.length, activeSurveys: activeSurveys.length,
        oldEdges: activeOldRowSurveyEdges.length + activeOldSurveyDepartmentEdges.length,
        directEdges: activeNewEdges.length, archivedRows: 0, writes: 0 },
    };
  }
  check(!newDefinition, 'New workforce Department relationship definition already exists before migration.');

  const oldEdges = new Map();
  for (const edge of edges) if (oldEdgeIds.includes(edge.id)) oldEdges.set(edge.id, edge);
  check(oldEdges.size === oldEdgeIds.length, 'Legacy workforce edge disappeared while planning.');
  const newEdges = [...departmentByRow.entries()].map(([source_record_id, target_record_id]) =>
    ({ source_record_id, target_record_id, field_values: {} }));
  const archivedRows = (state.records || []).filter((record) =>
    record.custom_object_id === ROW_OBJECT_ID && record.archived_at != null);
  check(archivedRows.every((row) => !surveyIdsToArchive.includes(row.id)),
    'Archived workforce rows were selected for archival; refusing migration.');

  return {
    completed: false,
    changed: true,
    newDefinition: expectedNewDefinition(rowSurvey),
    newEdges,
    archiveEdgeIds: [...new Set(oldEdgeIds)],
    archiveSurveyIds: surveyIdsToArchive,
    archiveDefinitionIds: [...OLD_DEFINITION_IDS],
    archiveObjectId: SURVEY_OBJECT_ID,
    departmentConfiguration: layout.configuration,
    departmentByRow: Object.fromEntries(departmentByRow),
    summary: {
      activeRows: activeRows.length,
      activeSurveys: activeSurveys.length,
      oldEdges: activeOldRowSurveyEdges.length + activeOldSurveyDepartmentEdges.length,
      directEdges: newEdges.length,
      archivedRows: 0,
      archiveEdges: oldEdgeIds.length,
      archiveSurveys: surveyIdsToArchive.length,
      archiveDefinitions: OLD_DEFINITION_IDS.size,
      archiveObjects: 1,
      configurationChanged: layout.changed,
      permissionGrants: state.relationshipPermissions?.length || 0,
      writes: newEdges.length + 1 + oldEdgeIds.length + surveyIdsToArchive.length + OLD_DEFINITION_IDS.size + 1
        + (layout.changed ? 1 : 0),
    },
  };
}

function orderedFingerprint(rows) {
  return fingerprint([...(rows || [])].sort((left, right) =>
    String(left?.id || '').localeCompare(String(right?.id || ''))));
}

function withoutArchiveAttributes(row) {
  return Object.fromEntries(Object.entries(row || {}).filter(([key]) =>
    !['archived_at', 'archived_by', 'archive_reason', 'updated_at', 'updated_by'].includes(key)));
}

/**
 * The postcondition is pure so the same safety checks can be unit-tested with
 * a stubbed state. It is called while the guarded SQL transaction is still
 * open; throwing from here causes the caller to roll back.
 */
export function verifyPostcondition(beforeState, afterState, plan) {
  const completed = buildPlan(afterState, { strictLiveCounts: true });
  check(completed.completed && completed.summary.activeRows === EXPECTED_ACTIVE_ROWS
    && completed.summary.directEdges === EXPECTED_ACTIVE_ROWS,
  'In-transaction postcondition did not reach the completed 8-row direct graph.');
  const beforeRows = (beforeState.records || []).filter((row) => row.custom_object_id === ROW_OBJECT_ID);
  const afterRows = (afterState.records || []).filter((row) => row.custom_object_id === ROW_OBJECT_ID);
  check(orderedFingerprint(beforeRows) === orderedFingerprint(afterRows),
    'In-transaction postcondition found workforce row-record byte drift.');
  const beforeSurveys = (beforeState.records || []).filter((row) =>
    plan.archiveSurveyIds.includes(row.id));
  const afterSurveys = (afterState.records || []).filter((row) =>
    plan.archiveSurveyIds.includes(row.id));
  check(orderedFingerprint(beforeSurveys.map(withoutArchiveAttributes))
    === orderedFingerprint(afterSurveys.map(withoutArchiveAttributes)),
  'In-transaction postcondition found survey data drift outside archive attributes.');
  check(orderedFingerprint(beforeState.objectGrants) === orderedFingerprint(afterState.objectGrants)
    && orderedFingerprint(beforeState.fieldGrants) === orderedFingerprint(afterState.fieldGrants),
  'In-transaction postcondition found object or field permission drift.');
  check(fingerprint(afterState.departmentConfiguration)
    === fingerprint(plan.departmentConfiguration),
  'In-transaction postcondition found an unintended Department layout.');
  check(fingerprint(afterState.objects?.find((row) => row.id === ROW_OBJECT_ID)?.primary_display_field_id)
    === fingerprint(beforeState.objects?.find((row) => row.id === ROW_OBJECT_ID)?.primary_display_field_id),
  'In-transaction postcondition found workforce row primary-display-field drift.');
  const expected = new Map(Object.entries(plan.departmentByRow));
  const direct = (afterState.edges || []).filter((edge) =>
    edge.relationship_definition_id === NEW_RELATIONSHIP_ID && active(edge));
  check(direct.length === expected.size && direct.every((edge) =>
    expected.get(edge.source_record_id) === edge.target_record_id),
  'In-transaction postcondition found an unexpected row-to-Department edge.');
  return { completed: true, rows: direct.length, grantsUnchanged: true, layoutIntended: true };
}

function relativePath(input) {
  const resolved = path.resolve(ROOT, input);
  check(resolved.startsWith(`${ROOT}${path.sep}`), 'Report paths must remain inside the workspace.');
  return resolved;
}

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const review = argv.find((arg) => arg.startsWith('--review='));
  const report = argv.find((arg) => arg.startsWith('--report='));
  check(argv.every((arg) => arg === '--apply' || arg.startsWith('--review=') || arg.startsWith('--report=')),
    'Supported arguments are --apply, --review=<path>, and --report=<path>.');
  check(!apply || review, '--apply requires an explicit reviewed dry-run report via --review=<path>.');
  return { apply, review, report };
}

async function queryRows(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows.map((row) => row.row ?? row);
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${tableName}`],
  );
  return result.rows[0]?.present === true;
}

async function loadPermissionInfo(client, oldRelationshipId, newRelationshipId = null) {
  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'custom_object_relationship_permission'
  `);
  if (!tables.rowCount) return { table: null, columns: [], rows: [] };
  const table = tables.rows[0].table_name;
  const columns = (await client.query(`
    SELECT column_name, is_nullable, column_default, is_generated, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table])).rows;
  const names = new Set(columns.map((column) => column.column_name));
  check(names.has('relationship_definition_id') && names.has('tenant_id'),
    'Dedicated relationship permission table has an unsupported shape; refusing migration.');
  const ids = [oldRelationshipId, ...(newRelationshipId ? [newRelationshipId] : [])];
  const rows = await client.query(
    `SELECT to_jsonb(p) AS row FROM public.custom_object_relationship_permission p
     WHERE p.tenant_id = $1 AND p.relationship_definition_id = ANY($2::uuid[])`,
    [TENANT_ID, ids],
  );
  return { table, columns, rows: rows.rows.map((row) => row.row) };
}

async function copyRelationshipPermissions(client, permissionInfo) {
  if (!permissionInfo?.table || !permissionInfo.rows.length) return 0;
  const usable = permissionInfo.columns.filter((column) =>
    column.column_name !== 'id' && column.is_generated === 'NEVER');
  const idColumn = permissionInfo.columns.find((column) => column.column_name === 'id');
  check(!idColumn || idColumn.column_default || idColumn.is_nullable === 'YES',
    'Dedicated relationship permission primary key has no safe default.');
  check(usable.length > 0, 'Dedicated relationship permission table has no insertable grant columns.');
  const names = usable.map((column) => quoteIdentifier(column.column_name));
  const expressions = usable.map((column) => column.column_name === 'relationship_definition_id'
    ? '$2::uuid'
    : `p.${quoteIdentifier(column.column_name)}`);
  const table = quoteIdentifier(permissionInfo.table);
  const result = await client.query(`
    INSERT INTO public.${table} (${names.join(', ')})
    SELECT ${expressions.join(', ')}
    FROM public.${table} p
    WHERE p.tenant_id = $1 AND p.relationship_definition_id = $3::uuid
  `, [TENANT_ID, NEW_RELATIONSHIP_ID, OLD_ROW_SURVEY_RELATIONSHIP_ID]);
  return result.rowCount;
}

async function readAccessRows(client, table, tenantId, predicate, extraParams = []) {
  if (!await tableExists(client, table)) return [];
  check(['custom_object_role_permission', 'custom_object_field_role_permission'].includes(table),
    'Unexpected access-table identifier.');
  return queryRows(client,
    `SELECT to_jsonb(p) AS row FROM public.${table} p
     WHERE p.tenant_id = $1 AND (${predicate})`,
    [tenantId, ...extraParams]);
}

async function readTableReferences(client, table, ids) {
  if (!await tableExists(client, table)) return [];
  check([
    'custom_object_audit_event',
    'custom_object_report_export_chunk',
    'custom_object_report_export_job',
  ].includes(table), 'Unexpected custom-object reference table.');
  const columns = (await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
  `, [table])).rows.map((row) => row.column_name);
  const chunkIdentity = table === 'custom_object_report_export_chunk'
    && columns.includes('job_id') && columns.includes('chunk_index');
  check((columns.includes('id') || chunkIdentity) && columns.includes('tenant_id'),
    `${table} has no inspectable tenant/id columns; refusing migration.`);
  const identitySql = chunkIdentity
    ? "t.job_id::text || ':' || t.chunk_index::text"
    : 't.id';
  return (await client.query(
    `SELECT ${identitySql} AS id FROM public.${table} t
     WHERE t.tenant_id = $1 AND to_jsonb(t)::text LIKE ANY($2::text[])`,
    [TENANT_ID, ids.map((id) => `%${id}%`)],
  )).rows.map((row) => row.id);
}

async function loadSnapshot(client) {
  const tenant = (await client.query('SELECT id FROM public.tenant WHERE id = $1', [TENANT_ID])).rows[0];
  check(tenant?.id === TENANT_ID, 'Pinned BNMS tenant is unavailable.');
  const objectIds = [DEPARTMENT_OBJECT_ID, SURVEY_OBJECT_ID, ROW_OBJECT_ID];
  const objects = await queryRows(client, `
    SELECT to_jsonb(o) AS row FROM public.custom_object_definition o
    WHERE o.tenant_id = $1 AND o.id = ANY($2::uuid[])
  `, [TENANT_ID, objectIds]);
  const definitions = await queryRows(client, `
    SELECT to_jsonb(d) AS row FROM public.custom_object_relationship_definition d
    WHERE d.tenant_id = $1
  `, [TENANT_ID]);
  const records = await queryRows(client, `
    SELECT to_jsonb(r) AS row FROM public.custom_object_record r
    WHERE r.tenant_id = $1 AND r.custom_object_id = ANY($2::uuid[])
  `, [TENANT_ID, objectIds]);
  const touchingDefinitions = definitions.filter((definition) =>
    definition.source_custom_object_id === SURVEY_OBJECT_ID
      || definition.target_custom_object_id === SURVEY_OBJECT_ID).map((definition) => definition.id);
  const edgeDefinitionIds = [...new Set([
    OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID, OLD_ROW_SURVEY_RELATIONSHIP_ID,
    NEW_RELATIONSHIP_ID, ...touchingDefinitions,
  ])];
  const edges = await queryRows(client, `
    SELECT to_jsonb(e) AS row FROM public.custom_object_relationship e
    WHERE e.tenant_id = $1 AND e.relationship_definition_id = ANY($2::uuid[])
  `, [TENANT_ID, edgeDefinitionIds]);
  const department = objects.find((object) => object.id === DEPARTMENT_OBJECT_ID);
  const oldIds = [...OLD_DEFINITION_IDS];
  const formReferences = (await client.query(`
    SELECT id FROM public.form f
    WHERE f.tenant_id = $1
      AND (to_jsonb(f)::text LIKE ANY($2::text[]))
  `, [TENANT_ID, oldIds.map((id) => `%${id}%`)])).rows.map((row) => row.id);
  const reportReferences = [];
  if (await tableExists(client, 'system_settings')) {
    const settings = await client.query(`
      SELECT id FROM public.system_settings s
      WHERE to_jsonb(s)::text LIKE ANY($1::text[])
    `, [oldIds.map((id) => `%${id}%`)]);
    reportReferences.push(...settings.rows.map((row) => row.id));
  }
  const auditHistory = await readTableReferences(client, 'custom_object_audit_event', oldIds);
  const reportExportReferences = [
    ...(await readTableReferences(client, 'custom_object_report_export_chunk', oldIds)),
    ...(await readTableReferences(client, 'custom_object_report_export_job', oldIds)),
  ];
  const unsupportedReferences = objects
    .filter((object) => object.id !== DEPARTMENT_OBJECT_ID
      && oldIds.some((id) => containsId(object.configuration, id)))
    .map((object) => object.id);
  const permissionInfo = await loadPermissionInfo(client, OLD_ROW_SURVEY_RELATIONSHIP_ID, NEW_RELATIONSHIP_ID);
  const currentSetConfigInstalled = await tableExists(client, 'department_current_set_config');
  const relationshipTriggers = (await client.query(`
    SELECT c.relname AS table_name, t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('custom_object_definition', 'custom_object_relationship_definition',
        'custom_object_relationship', 'custom_object_record')
      AND NOT t.tgisinternal
  `)).rows;
  check(!currentSetConfigInstalled,
    'department_current_set_config is installed; this independent graph migration is fail-closed.');
  const state = {
    tenantId: TENANT_ID, objects, definitions, records, edges,
    departmentConfiguration: department?.configuration,
    formReferences, reportReferences, auditHistory, reportExportReferences, unsupportedReferences,
    relationshipPermissions: permissionInfo.rows.filter((row) =>
      row.relationship_definition_id === OLD_ROW_SURVEY_RELATIONSHIP_ID),
    objectGrants: await readAccessRows(client, 'custom_object_role_permission', TENANT_ID,
      `custom_object_id = ANY($2::uuid[])`, [objectIds]),
    fieldGrants: [],
    permissionInfo, relationshipTriggers,
    rowPrimaryDisplayFieldId: objects.find((object) => object.id === ROW_OBJECT_ID)?.primary_display_field_id,
  };
  state.fieldGrants = await readAccessRows(client, 'custom_object_field_role_permission', TENANT_ID,
    `p.field_id IN (
       SELECT f.id FROM public.preference_field f
       WHERE f.tenant_id = $1 AND f.custom_object_id = ANY($2::uuid[])
     )`, [objectIds]);
  return { state, scope: relevantScope(state), currentSetConfigInstalled };
}

function reportFor(state, plan, dryRun) {
  const scope = relevantScope(state);
  return {
    review_version: 1,
    generated_at: new Date().toISOString(),
    tenantId: TENANT_ID,
    dryRun,
    preflightFingerprint: fingerprint(scope),
    summary: {
      ...plan.summary,
      completedReplay: plan.completed,
      directDepartmentResolution: 'exactly_one_per_active_workforce_row',
      rowDataIncluded: false,
    },
    metadata: {
      oldSurveyObjectArchived: state.objects.some(object =>
        object.id === SURVEY_OBJECT_ID && object.status === 'archived' && object.archived_at),
      oldRelationshipDefinitionsArchived: state.definitions
        .filter(definition => OLD_DEFINITION_IDS.has(definition.id)
          && definition.status === 'archived' && definition.archived_at)
        .map(definition => definition.id).sort(),
      plannedObjectArchives: plan.archiveObjectId ? [plan.archiveObjectId] : [],
      plannedRelationshipArchives: plan.archiveDefinitionIds || [],
      workforceRowsArchived: false,
      rowPrimaryDisplayFieldPreserved: true,
      departmentLayoutChanged: plan.summary.configurationChanged,
      permissionTable: state.permissionInfo.table,
      permissionGrantsInspected: state.relationshipPermissions.length,
      objectGrantsInspected: state.objectGrants.length,
      fieldGrantsInspected: state.fieldGrants.length,
      auditHistoryRowsInspected: state.auditHistory.length,
      triggerCountInspected: state.relationshipTriggers.length,
    },
    safety: {
      destinationOnly: true,
      noWritesDuringDryRun: dryRun,
      transactionAndPinnedLocks: true,
      reviewedFingerprintRequired: true,
      noRawRecordDataReported: true,
      departmentCurrentSetConfigRequiredAbsent: true,
      unsupportedReferencesRejected: true,
    },
  };
}

async function destinationClient() {
  const connectionString = process.env.DEST_DATABASE_URL;
  check(connectionString, 'DEST_DATABASE_URL is required; source and bare DATABASE_URL are forbidden.');
  const destination = new URL(connectionString);
  const allowed = new Set([
    'aws-1-eu-central-1.pooler.supabase.com',
    'db.lvmzliemqnieeoruhkik.supabase.co',
  ]);
  check(allowed.has(destination.hostname) && (!destination.port || destination.port === '5432'),
    'Destination SQL host pin mismatch; use the BNMS direct database or IPv4 pooler.');
  if (destination.hostname.endsWith('.pooler.supabase.com')) {
    check(decodeURIComponent(destination.username).endsWith(DESTINATION_PROJECT_SUFFIX),
      'Shared pool username is not pinned to the BNMS Supabase project.');
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    destination.searchParams.delete(key);
  }
  const caResponse = await fetch(DESTINATION_CA_URL);
  check(caResponse.ok, `Destination CA download failed with HTTP ${caResponse.status}.`);
  const ca = await caResponse.text();
  check(ca.includes('BEGIN CERTIFICATE'), 'Destination CA download was not a PEM certificate.');
  return { client: new pg.Client({
    connectionString: destination.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: destination.hostname },
  }), hostname: destination.hostname };
}

async function readReview(argument) {
  const reviewPath = relativePath(argument.slice('--review='.length));
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  check(review?.review_version === 1 && review.tenantId === TENANT_ID
    && typeof review.preflightFingerprint === 'string',
  'Review report is not a valid pinned BNMS workforce preflight.');
  return review;
}

function quoteIdentifier(identifier) {
  check(/^[a-z_][a-z0-9_]*$/i.test(identifier), `Unsafe database identifier ${identifier}.`);
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function applyAtomically(snapshot, plan) {
  const { client } = await destinationClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `bnms-workforce-direct-department:${TENANT_ID}`,
    ]);
    await client.query('SELECT id FROM public.tenant WHERE id = $1 FOR KEY SHARE', [TENANT_ID]);
    await client.query(`
      LOCK TABLE public.custom_object_record, public.custom_object_relationship,
        public.custom_object_definition, public.custom_object_relationship_definition,
        public.preference_field
      IN SHARE ROW EXCLUSIVE MODE
    `);
    const locked = await loadSnapshot(client);
    const lockedFingerprint = fingerprint(relevantScope(locked.state));
    check(lockedFingerprint === fingerprint(snapshot.scope),
      'Destination graph drifted after review; transaction rolled back.');
    const lockedPlan = buildPlan(locked.state, { strictLiveCounts: false });
    check(fingerprint(lockedPlan) === fingerprint(plan),
      'Destination workforce plan changed after review; transaction rolled back.');
    if (lockedPlan.completed) {
      verifyPostcondition(snapshot.state, locked.state, lockedPlan);
      await client.query('COMMIT');
      return { applied: false, noOp: true, postcondition: { completed: true } };
    }

    const definition = lockedPlan.newDefinition;
    await client.query(`
      INSERT INTO public.custom_object_relationship_definition
        (id, tenant_id, relationship_key, source_kind, source_custom_object_id,
         target_kind, target_custom_object_id, cardinality, source_label, target_label,
         is_required, show_on_source, show_on_target, edit_from_source, edit_from_target,
         status, configuration, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
    `, [definition.id, definition.tenant_id, definition.relationship_key, definition.source_kind,
      definition.source_custom_object_id, definition.target_kind, definition.target_custom_object_id,
      definition.cardinality, definition.source_label, definition.target_label, definition.is_required,
      definition.show_on_source, definition.show_on_target, definition.edit_from_source,
      definition.edit_from_target, definition.status, JSON.stringify(definition.configuration),
      'bnms-workforce-direct-department']);
    await copyRelationshipPermissions(client, locked.state.permissionInfo);

    for (const edge of lockedPlan.newEdges) {
      await client.query(`
        INSERT INTO public.custom_object_relationship
          (tenant_id, relationship_definition_id, source_record_id, target_record_id,
           field_values, created_by, updated_by)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6)
      `, [TENANT_ID, NEW_RELATIONSHIP_ID, edge.source_record_id, edge.target_record_id,
        JSON.stringify(edge.field_values), 'bnms-workforce-direct-department']);
    }
    // Retire the old required contracts before removing their active edges.
    // The replacement required relationship and all direct edges already exist.
    await client.query(`
      UPDATE public.custom_object_relationship_definition
      SET archived_at = COALESCE(archived_at, clock_timestamp()),
          archived_by = COALESCE(archived_by, $2),
          status = CASE WHEN archived_at IS NULL THEN 'archived' ELSE status END,
          updated_by = COALESCE(updated_by, $2)
      WHERE tenant_id = $1 AND id = ANY($3::uuid[])
    `, [TENANT_ID, 'bnms-workforce-direct-department', lockedPlan.archiveDefinitionIds]);
    if (lockedPlan.archiveEdgeIds.length) {
      await client.query(`
        UPDATE public.custom_object_relationship
        SET archived_at = COALESCE(archived_at, clock_timestamp()),
            archived_by = COALESCE(archived_by, $2),
            updated_by = COALESCE(updated_by, $2)
        WHERE tenant_id = $1 AND id = ANY($3::uuid[])
      `, [TENANT_ID, 'bnms-workforce-direct-department', lockedPlan.archiveEdgeIds]);
    }
    if (lockedPlan.archiveSurveyIds.length) {
      await client.query(`
        UPDATE public.custom_object_record
        SET archived_at = COALESCE(archived_at, clock_timestamp()),
            archived_by = COALESCE(archived_by, $2),
            archive_reason = COALESCE(archive_reason, $3),
            updated_by = COALESCE(updated_by, $2)
        WHERE tenant_id = $1 AND id = ANY($4::uuid[])
      `, [TENANT_ID, 'bnms-workforce-direct-department',
        'Redundant BNMS workforce survey parent; direct Department relationship retained', lockedPlan.archiveSurveyIds]);
    }
    await client.query(`
      UPDATE public.custom_object_definition
      SET archived_at = COALESCE(archived_at, clock_timestamp()),
          archived_by = COALESCE(archived_by, $2),
          status = CASE WHEN archived_at IS NULL THEN 'archived' ELSE status END,
          updated_by = COALESCE(updated_by, $2)
      WHERE tenant_id = $1 AND id = $3
    `, [TENANT_ID, 'bnms-workforce-direct-department', SURVEY_OBJECT_ID]);
    if (fingerprint(lockedPlan.departmentConfiguration)
      !== fingerprint(locked.state.departmentConfiguration)) {
      const configUpdate = await client.query(`
        UPDATE public.custom_object_definition
        SET configuration = $1::jsonb, updated_by = $2
        WHERE tenant_id = $3 AND id = $4
          AND configuration = $5::jsonb
      `, [JSON.stringify(lockedPlan.departmentConfiguration), 'bnms-workforce-direct-department',
        TENANT_ID, DEPARTMENT_OBJECT_ID, JSON.stringify(locked.state.departmentConfiguration)]);
      check(configUpdate.rowCount === 1, 'Department layout changed during the guarded transaction.');
    }
    const postcondition = await loadSnapshot(client);
    verifyPostcondition(snapshot.state, postcondition.state, lockedPlan);
    await client.query('COMMIT');
    return { applied: true, noOp: false, postcondition: { completed: true } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const { apply, review, report } = parseArgs(process.argv.slice(2));
  const { client } = await destinationClient();
  await client.connect();
  let loaded;
  try {
    loaded = await loadSnapshot(client);
  } finally {
    await client.end();
  }
  const plan = buildPlan(loaded.state, { strictLiveCounts: true });
  let output = reportFor(loaded.state, plan, !apply);
  if (apply) {
    const reviewed = await readReview(review);
    check(reviewed.preflightFingerprint === output.preflightFingerprint,
      'Destination state differs from the reviewed dry run; no write was attempted.');
    const applied = await applyAtomically(loaded, plan);
    const { client: verifyClient } = await destinationClient();
    await verifyClient.connect();
    let verified;
    try {
      verified = await loadSnapshot(verifyClient);
    } finally {
      await verifyClient.end();
    }
    const replay = buildPlan(verified.state, { strictLiveCounts: true });
    check(replay.completed, 'Post-apply replay did not reach the completed zero-write state.');
    check(replay.summary.activeRows === EXPECTED_ACTIVE_ROWS
      && replay.summary.directEdges === EXPECTED_ACTIVE_ROWS,
    'Post-apply verification did not find one direct Department edge for each active row.');
    output = { ...reportFor(verified.state, replay, false), applied: applied.applied, noOp: applied.noOp };
  }
  if (report) {
    const destination = relativePath(report.slice('--report='.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(output, null, 2)}\n`);
    output = { ...output, reportPath: path.relative(ROOT, destination) };
  }
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`bnms-workforce-direct-department: ${error.message || error}`);
    process.exitCode = 1;
  });
}
