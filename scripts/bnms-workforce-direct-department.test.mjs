import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEPARTMENT_OBJECT_ID,
  NEW_RELATIONSHIP_ID,
  NEW_RELATIONSHIP_KEY,
  OLD_ROW_SURVEY_RELATIONSHIP_ID,
  OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID,
  ROW_OBJECT_ID,
  SURVEY_OBJECT_ID,
  TENANT_ID,
  buildPlan,
  replaceDepartmentLayout,
  verifyPostcondition,
} from './bnms-workforce-direct-department.mjs';

const scriptSource = await readFile(new URL('./bnms-workforce-direct-department.mjs', import.meta.url), 'utf8');
const relationFields = [];
const definition = (id, source, target, extra = {}) => ({
  id,
  tenant_id: TENANT_ID,
  relationship_key: id === OLD_ROW_SURVEY_RELATIONSHIP_ID
    ? 'workforce_survey_row_survey' : 'workforce_survey_department',
  source_kind: 'custom_object',
  source_custom_object_id: source,
  target_kind: 'custom_object',
  target_custom_object_id: target,
  cardinality: 'many_to_one',
  source_label: 'Source',
  target_label: 'Target',
  is_required: true,
  show_on_source: true,
  show_on_target: true,
  edit_from_source: true,
  edit_from_target: id === OLD_ROW_SURVEY_RELATIONSHIP_ID,
  status: 'active',
  archived_at: null,
  configuration: { relationship_fields: relationFields },
  ...extra,
});

function baseState() {
  const objects = [
    {
      id: DEPARTMENT_OBJECT_ID, tenant_id: TENANT_ID, object_key: 'org_department',
      status: 'active', archived_at: null, primary_display_field_id: 'department-name',
      configuration: {
        views: {
          detail: {
            version: 1,
            cards: [
              { id: 'workforce', title: 'Workforce & Equipment', columns: 2, fields: [
                { id: `relationship:${OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID}:target`, type: 'relationship',
                  definitionId: OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID, side: 'target', columnIndex: 0 },
                { id: 'field:other', type: 'field', field_id: 'other', columnIndex: 1 },
              ] },
              { id: 'other-card', title: 'Other', columns: 1, fields: [] },
            ],
          },
        },
      },
    },
    {
      id: SURVEY_OBJECT_ID, tenant_id: TENANT_ID, object_key: 'workforce_survey',
      status: 'active', archived_at: null, configuration: {},
    },
    {
      id: ROW_OBJECT_ID, tenant_id: TENANT_ID, object_key: 'workforce_survey_row',
      status: 'active', archived_at: null, primary_display_field_id: 'row-name', configuration: {},
    },
  ];
  const departments = ['d1', 'd2', 'd3'].map((id) => ({
    id, tenant_id: TENANT_ID, custom_object_id: DEPARTMENT_OBJECT_ID, archived_at: null, data: { name: id },
  }));
  const surveys = ['s1', 's2', 's3'].map((id) => ({
    id, tenant_id: TENANT_ID, custom_object_id: SURVEY_OBJECT_ID, archived_at: null, data: { survey_name: id },
  }));
  const rows = Array.from({ length: 8 }, (_, index) => ({
    id: `r${index + 1}`, tenant_id: TENANT_ID, custom_object_id: ROW_OBJECT_ID,
    archived_at: null, data: { row_name: `row-${index + 1}` },
  }));
  const edges = [];
  rows.forEach((row, index) => edges.push({
    id: `row-edge-${index + 1}`, tenant_id: TENANT_ID,
    relationship_definition_id: OLD_ROW_SURVEY_RELATIONSHIP_ID,
    source_record_id: row.id, target_record_id: surveys[index % 3].id,
    archived_at: null, field_values: {},
  }));
  surveys.forEach((survey, index) => edges.push({
    id: `survey-edge-${index + 1}`, tenant_id: TENANT_ID,
    relationship_definition_id: OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID,
    source_record_id: survey.id, target_record_id: departments[index].id,
    archived_at: null, field_values: {},
  }));
  return {
    tenantId: TENANT_ID,
    objects,
    definitions: [
      definition(OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID, SURVEY_OBJECT_ID, DEPARTMENT_OBJECT_ID,
        { edit_from_target: false }),
      definition(OLD_ROW_SURVEY_RELATIONSHIP_ID, ROW_OBJECT_ID, SURVEY_OBJECT_ID),
    ],
    records: [...departments, ...surveys, ...rows],
    edges,
    departmentConfiguration: objects[0].configuration,
    formReferences: [],
    reportReferences: [],
    unsupportedReferences: [],
    rowPrimaryDisplayFieldId: 'row-name',
    relationshipPermissions: [],
    objectGrants: [{ id: 'object-grant', can_view_records: true }],
    fieldGrants: [{ id: 'field-grant', access_level: 'edit' }],
  };
}

test('unambiguous graph produces direct Department edges without row-data writes', () => {
  const plan = buildPlan(baseState(), { strictLiveCounts: true });
  assert.equal(plan.completed, false);
  assert.equal(plan.newEdges.length, 8);
  assert.equal(plan.archiveEdgeIds.length, 11);
  assert.equal(plan.archiveSurveyIds.length, 3);
  assert.equal(plan.newDefinition.id, NEW_RELATIONSHIP_ID);
  assert.equal(plan.summary.configurationChanged, true);
});

test('multi-parent survey is rejected', () => {
  const state = baseState();
  state.edges.push({
    id: 'duplicate-parent', tenant_id: TENANT_ID,
    relationship_definition_id: OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID,
    source_record_id: 's1', target_record_id: 'd2', archived_at: null, field_values: {},
  });
  assert.throws(() => buildPlan(state), /missing or multiple Department parents/);
});

test('missing Department parent is rejected', () => {
  const state = baseState();
  state.records.find((row) => row.id === 'd1').archived_at = 'historic';
  assert.throws(() => buildPlan(state), /outside the active Department scope/);
});

test('cross-tenant graph rows are rejected before planning', () => {
  const state = baseState();
  state.edges[0].tenant_id = '00000000-0000-4000-8000-000000000001';
  assert.throws(() => buildPlan(state), /Cross-tenant graph row/);
});

test('archived workforce rows remain outside the archive plan', () => {
  const state = baseState();
  state.records.push({
    id: 'archived-row', tenant_id: TENANT_ID, custom_object_id: ROW_OBJECT_ID,
    archived_at: '2025-01-01T00:00:00Z', data: { historic: 'preserve' },
  });
  const plan = buildPlan(state);
  assert.equal(plan.summary.archivedRows, 0);
  assert.equal(plan.archiveSurveyIds.includes('archived-row'), false);
  assert.equal(plan.newEdges.some((edge) => edge.source_record_id === 'archived-row'), false);
});

test('layout replacement changes only the old target relationship reference', () => {
  const state = baseState();
  const before = structuredClone(state.departmentConfiguration);
  const result = replaceDepartmentLayout(before);
  assert.equal(result.changed, true);
  assert.equal(result.configuration.views.detail.cards[0].fields[0].id,
    `relationship:${NEW_RELATIONSHIP_ID}:target`);
  const expected = structuredClone(before);
  expected.views.detail.cards[0].fields[0].id = `relationship:${NEW_RELATIONSHIP_ID}:target`;
  expected.views.detail.cards[0].fields[0].definitionId = NEW_RELATIONSHIP_ID;
  assert.deepEqual(result.configuration, expected);
  assert.deepEqual(before.views.detail.cards[0].fields[1], state.departmentConfiguration.views.detail.cards[0].fields[1]);
});

test('new relationship ID collision is fail-closed', () => {
  const state = baseState();
  state.definitions.push(definition(NEW_RELATIONSHIP_ID, ROW_OBJECT_ID, DEPARTMENT_OBJECT_ID, {
    relationship_key: 'different_key',
  }));
  assert.throws(() => buildPlan(state), /already used by different metadata/);
});

test('completed replay is a zero-write plan', () => {
  const state = baseState();
  const beforeState = structuredClone(state);
  const initial = buildPlan(state);
  state.objects.find((row) => row.id === SURVEY_OBJECT_ID).status = 'archived';
  state.objects.find((row) => row.id === SURVEY_OBJECT_ID).archived_at = '2025-01-01T00:00:00Z';
  for (const id of [OLD_SURVEY_DEPARTMENT_RELATIONSHIP_ID, OLD_ROW_SURVEY_RELATIONSHIP_ID]) {
    const item = state.definitions.find((row) => row.id === id);
    item.status = 'archived';
    item.archived_at = '2025-01-01T00:00:00Z';
  }
  for (const row of state.records.filter((item) => item.custom_object_id === SURVEY_OBJECT_ID)) {
    row.archived_at = '2025-01-01T00:00:00Z';
  }
  state.edges = initial.newEdges.map((edge, index) => ({
    id: `direct-${index + 1}`, tenant_id: TENANT_ID, relationship_definition_id: NEW_RELATIONSHIP_ID,
    source_record_id: edge.source_record_id, target_record_id: edge.target_record_id,
    archived_at: null, field_values: {},
  }));
  state.definitions.push({
    ...initial.newDefinition,
    configuration: { relationship_fields: [] },
  });
  state.departmentConfiguration = replaceDepartmentLayout(state.departmentConfiguration).configuration;
  const replay = buildPlan(state, { strictLiveCounts: true });
  assert.equal(replay.completed, true);
  assert.equal(replay.summary.writes, 0);
  assert.equal(replay.newEdges.length, 0);
  assert.deepEqual(replay.archiveEdgeIds, []);
  assert.deepEqual(
    verifyPostcondition(beforeState, state, initial),
    { completed: true, rows: 8, grantsUnchanged: true, layoutIntended: true },
  );
});

test('destination TLS uses the verified Supabase CA and pins shared-pool credentials', () => {
  assert.match(scriptSource, /prod-ca-2021\.crt/);
  assert.match(scriptSource, /rejectUnauthorized: true/);
  assert.match(scriptSource, /servername: destination\.hostname/);
  assert.match(scriptSource, /DESTINATION_PROJECT_SUFFIX/);
  assert.match(scriptSource, /destination\.searchParams\.delete\(key\)/);
  assert.match(scriptSource, /const caResponse = await fetch\(DESTINATION_CA_URL\)/);
});

test('replacement edges exist before retiring required contracts and archiving their old edges', () => {
  const directEdges = scriptSource.indexOf('INSERT INTO public.custom_object_relationship\n');
  const retiredContract = scriptSource.indexOf('UPDATE public.custom_object_relationship_definition\n');
  const archivedEdges = scriptSource.indexOf('UPDATE public.custom_object_relationship\n');
  assert.ok(directEdges >= 0 && retiredContract > directEdges);
  assert.ok(archivedEdges > retiredContract,
    'The database rejects removing the last edge of a still-active required definition');
});
