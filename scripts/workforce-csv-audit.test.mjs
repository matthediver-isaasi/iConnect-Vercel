import test from 'node:test';
import assert from 'node:assert/strict';

import { auditSourceAgainstState, resolveOption } from './workforce-csv-audit.mjs';
import { ROW, SURVEY, TENANT } from './workforce-readonly-state.mjs';

const DEPARTMENT = 'dept-fixture';
const DEPARTMENT_OBJECT = 'department-object-fixture';
const OTHER_TENANT = 'foreign-tenant-fixture';
const OTHER_OBJECT = 'foreign-object-fixture';
const SURVEY_DEPARTMENT_RELATIONSHIP = 'rel-survey-department-fixture';
const ROW_SURVEY_RELATIONSHIP = 'rel-row-survey-fixture';

const optionValues = {
  staff_group: ['Nuclear Medicine'],
  grade: ['Band 7'],
  legacy_vacancy_reported: ['No', 'Yes'],
};

function field(id, customObjectId, name, fieldType, isRequired, options) {
  return {
    id,
    tenant_id: TENANT,
    custom_object_id: customObjectId,
    entity_scope: 'custom_object',
    name,
    label: name,
    field_type: fieldType,
    is_required: isRequired,
    is_active: true,
    archived_at: null,
    ...(options ? { options } : {}),
  };
}

function departmentRecord(id = DEPARTMENT, overrides = {}) {
  return {
    id,
    tenant_id: TENANT,
    custom_object_id: DEPARTMENT_OBJECT,
    archived_at: null,
    data: { name: 'Nuclear Medicine', ...overrides },
  };
}

function surveyRecord(id, reportingYear) {
  return {
    id,
    tenant_id: TENANT,
    custom_object_id: SURVEY,
    archived_at: null,
    data: { survey_name: reportingYear },
  };
}

function rowRecord(id, data, overrides = {}) {
  return {
    id,
    tenant_id: TENANT,
    custom_object_id: ROW,
    archived_at: null,
    data: { ...data },
    ...overrides,
  };
}

function relationshipDefinition(id, relationshipKey, sourceObjectId, targetObjectId, overrides = {}) {
  return {
    id,
    tenant_id: TENANT,
    relationship_key: relationshipKey,
    source_kind: 'custom_object',
    target_kind: 'custom_object',
    source_custom_object_id: sourceObjectId,
    target_custom_object_id: targetObjectId,
    cardinality: 'many_to_one',
    is_required: true,
    show_on_source: true,
    edit_from_source: true,
    configuration: {},
    ...overrides,
  };
}

function relationshipEdge(definition, sourceRecordId, targetRecordId, overrides = {}) {
  return {
    id: `edge-${definition.id}-${sourceRecordId}-${targetRecordId}`,
    tenant_id: TENANT,
    relationship_definition_id: definition.id,
    source_record_id: sourceRecordId,
    target_record_id: targetRecordId,
    archived_at: null,
    ...overrides,
  };
}

function rowData(overrides = {}) {
  return {
    row_name: '2024',
    staff_group: 'Nuclear Medicine',
    grade: 'Band 7',
    occupied_wte: 1.25,
    vacant_wte: 0,
    legacy_vacancy_reported: 'No',
    ...overrides,
  };
}

function sourceRows(...dataRows) {
  return {
    fingerprint: 'fixture-source-fingerprint',
    reportingYear: '2024',
    rows: dataRows.map((data, index) => ({
      sourceRow: index + 2,
      departmentId: DEPARTMENT,
      originalLegacy: data.legacy_vacancy_reported,
      occupiedHundredths: Math.round(data.occupied_wte * 100),
      data,
    })),
  };
}

function baseState({ departments = [departmentRecord()], records = [], edges = [], definitions } = {}) {
  const relationshipDefinitions = definitions ?? [
    relationshipDefinition(
      SURVEY_DEPARTMENT_RELATIONSHIP,
      'workforce_survey_department',
      SURVEY,
      DEPARTMENT_OBJECT,
    ),
    relationshipDefinition(
      ROW_SURVEY_RELATIONSHIP,
      'workforce_survey_row_survey',
      ROW,
      SURVEY,
    ),
  ];

  const objects = [
    {
      id: DEPARTMENT_OBJECT,
      tenant_id: TENANT,
      object_key: 'org_department',
      singular_label: 'Department',
      status: 'active',
    },
    {
      id: SURVEY,
      tenant_id: TENANT,
      object_key: 'workforce_survey',
      singular_label: 'Workforce survey',
      status: 'active',
    },
    {
      id: ROW,
      tenant_id: TENANT,
      object_key: 'workforce_survey_row',
      singular_label: 'Workforce Survey Row',
      status: 'active',
    },
  ];

  const fields = [
    field('field-survey-name', SURVEY, 'survey_name', 'text', true),
    field('field-row-name', ROW, 'row_name', 'text', true),
    field('field-staff-group', ROW, 'staff_group', 'dropdown', true, optionValues.staff_group),
    field('field-grade', ROW, 'grade', 'dropdown', true, optionValues.grade),
    field('field-occupied-wte', ROW, 'occupied_wte', 'decimal', true),
    field('field-vacant-wte', ROW, 'vacant_wte', 'decimal', false),
    field(
      'field-legacy-vacancy-reported',
      ROW,
      'legacy_vacancy_reported',
      'dropdown',
      false,
      optionValues.legacy_vacancy_reported,
    ),
  ];

  return {
    tenant: { id: TENANT, name: 'BNMS' },
    objects,
    fields,
    definitions: relationshipDefinitions,
    records: [...departments, ...records],
    departments,
    edges,
  };
}

function withSurveyAndRows({
  reportingYear = '2024',
  surveyId = 'survey-existing',
  rows = [],
  state = baseState(),
} = {}) {
  const surveyDefinition = state.definitions.find(
    definition => definition.relationship_key === 'workforce_survey_department',
  );
  const rowDefinition = state.definitions.find(
    definition => definition.relationship_key === 'workforce_survey_row_survey',
  );
  state.records.push(surveyRecord(surveyId, reportingYear));
  state.edges.push(relationshipEdge(surveyDefinition, surveyId, DEPARTMENT));
  for (const [index, data] of rows.entries()) {
    const id = `row-existing-${index + 1}`;
    state.records.push(rowRecord(id, data));
    state.edges.push(relationshipEdge(rowDefinition, id, surveyId));
  }
  return state;
}

function codes(result) {
  return result.blockers.map(blocker => blocker.code);
}

function clone(value) {
  return structuredClone(value);
}

test('valid duplicate source occurrences remain distinct and are all planned for creation', () => {
  const data = rowData();
  const result = auditSourceAgainstState(sourceRows(data, { ...data }), baseState());

  assert.equal(result.readiness, 'AWAITING_SEPARATE_APPROVAL');
  assert.deepEqual(result.counts.surveys, { create: 1, reuse: 0, conflict: 0 });
  assert.deepEqual(result.counts.rows, { create: 2, reuse: 0, conflict: 0 });
  assert.equal(result.groups[0].rowsCreate, 2);
  assert.equal(new Set(result.rowPlan.map(row => row.provisionalIdentity)).size, 2);
  assert.ok(result.rowPlan.every(row => row.action === 'create'));
  assert.equal(result.counts.directRowDepartmentEdgesPlanned, 0);
});

test('one exact existing row is reused for one source occurrence', () => {
  const data = rowData();
  const state = withSurveyAndRows({ rows: [data] });
  const result = auditSourceAgainstState(sourceRows(data), state);

  assert.equal(result.readiness, 'AWAITING_SEPARATE_APPROVAL');
  assert.deepEqual(result.counts.surveys, { create: 0, reuse: 1, conflict: 0 });
  assert.deepEqual(result.counts.rows, { create: 0, reuse: 1, conflict: 0 });
  assert.equal(result.rowPlan[0].action, 'reuse');
  assert.equal(result.rowPlan[0].existingId, 'row-existing-1');
  assert.equal(result.groups[0].existingRowsPreservedWithoutReuse.length, 0);
});

test('repeated identical source occurrences conflict against one or multiple existing rows', () => {
  const data = rowData();
  for (const existingRows of [[data], [data, { ...data }]]) {
    const state = withSurveyAndRows({ rows: existingRows });
    const result = auditSourceAgainstState(sourceRows(data, { ...data }), state);

    assert.equal(result.readiness, 'BLOCKED');
    assert.deepEqual(result.counts.rows, { create: 0, reuse: 0, conflict: 2 });
    assert.ok(codes(result).includes('ROW_MATCH'));
    assert.ok(result.rowPlan.every(row => row.action === 'conflict'));
    assert.ok(result.rowPlan.every(row => row.existingId === null));
  }
});

test('an existing prior-year sample survey and its rows are preserved outside the source', () => {
  const priorYearData = rowData({ row_name: '2023' });
  const state = withSurveyAndRows({
    reportingYear: '2023',
    surveyId: 'survey-prior-sample',
    rows: [priorYearData],
  });
  const result = auditSourceAgainstState(sourceRows(rowData()), state);

  assert.equal(result.readiness, 'AWAITING_SEPARATE_APPROVAL');
  assert.equal(result.groups[0].surveyAction, 'create');
  assert.equal(result.counts.outsideSurveysPreserved, 1);
  assert.equal(result.counts.outsideRowsPreserved, 1);
  assert.deepEqual(result.outsideSurveys[0], {
    id: 'survey-prior-sample',
    reportingYear: '2023',
    departmentIds: [DEPARTMENT],
    rowIds: ['row-existing-1'],
    validLineage: true,
    action: 'preserve',
  });
});

test('duplicate active surveys for the same Department and reporting year conflict', () => {
  const state = withSurveyAndRows({ surveyId: 'survey-duplicate-1' });
  withSurveyAndRows({ surveyId: 'survey-duplicate-2', state });
  const result = auditSourceAgainstState(sourceRows(rowData()), state);

  assert.equal(result.readiness, 'BLOCKED');
  assert.equal(result.groups[0].surveyAction, 'conflict');
  assert.deepEqual(result.counts.surveys, { create: 0, reuse: 0, conflict: 1 });
  assert.deepEqual(result.counts.rows, { create: 0, reuse: 0, conflict: 1 });
  assert.ok(codes(result).includes('SURVEY_MATCH'));
});

test('missing, archived, foreign, and wrong-object Departments are never import targets', () => {
  const cases = [
    ['missing', 'department-missing', undefined],
    ['archived', 'department-archived', {
      ...departmentRecord('department-archived'),
      archived_at: '2024-01-01',
    }],
    ['cross-tenant', 'department-foreign', {
      ...departmentRecord('department-foreign'),
      tenant_id: OTHER_TENANT,
    }],
    ['wrong-object', 'department-wrong-object', {
      ...departmentRecord('department-wrong-object'),
      custom_object_id: OTHER_OBJECT,
    }],
  ];

  for (const [status, departmentId, department] of cases) {
    const departments = department ? [department] : [];
    const state = baseState({ departments });
    const source = sourceRows(rowData()).rows;
    source[0].departmentId = departmentId;
    const result = auditSourceAgainstState({ ...sourceRows(rowData()), rows: source }, state);

    assert.equal(result.readiness, 'BLOCKED', status);
    assert.equal(result.groups[0].departmentStatus, status);
    assert.equal(result.groups[0].surveyAction, 'conflict');
    assert.equal(result.counts.departments[status], 1);
    assert.ok(codes(result).includes('DEPARTMENT'));
  }
});

test('wrong relationship direction or cardinality blocks the group', () => {
  const cases = [
    {
      name: 'wrong direction',
      mutate: definitions => {
        definitions[0].source_custom_object_id = DEPARTMENT_OBJECT;
        definitions[0].target_custom_object_id = SURVEY;
      },
    },
    {
      name: 'wrong cardinality',
      mutate: definitions => {
        definitions[1].cardinality = 'one_to_many';
      },
    },
  ];

  for (const { name, mutate } of cases) {
    const state = baseState();
    mutate(state.definitions);
    const result = auditSourceAgainstState(sourceRows(rowData()), state);

    assert.equal(result.readiness, 'BLOCKED', name);
    assert.equal(result.groups[0].surveyAction, 'conflict');
    assert.ok(codes(result).includes('RELATIONSHIP_CONTRACT'));
  }
});

test('an additional required field is reported as a value contract gap', () => {
  const state = baseState();
  state.fields.push(field('field-extra-required', ROW, 'new_required_field', 'text', true));
  const result = auditSourceAgainstState(sourceRows(rowData()), state);

  assert.equal(result.readiness, 'BLOCKED');
  assert.equal(result.counts.mappingBlockedRows, 1);
  assert.ok(codes(result).includes('REQUIRED_OR_VALUE'));
  assert.match(result.requiredGaps[0].message, /new_required_field/);
  assert.deepEqual(result.requiredGaps[0].lines, [2]);
});

test('foreign, malformed, and multiple relationship edges make existing lineage ambiguous', () => {
  const data = rowData();

  const foreignEdgeState = withSurveyAndRows({ rows: [data] });
  foreignEdgeState.edges[0].tenant_id = OTHER_TENANT;
  const foreignEdgeResult = auditSourceAgainstState(sourceRows(data), foreignEdgeState);
  assert.equal(foreignEdgeResult.groups[0].surveyAction, 'conflict');
  assert.ok(codes(foreignEdgeResult).includes('SURVEY_PARENT'));

  const multipleEdgeState = withSurveyAndRows({ rows: [data] });
  multipleEdgeState.edges.push(clone(multipleEdgeState.edges[0]));
  multipleEdgeState.edges[1].id = 'edge-survey-duplicate';
  const multipleEdgeResult = auditSourceAgainstState(sourceRows(data), multipleEdgeState);
  assert.equal(multipleEdgeResult.groups[0].surveyAction, 'conflict');
  assert.ok(codes(multipleEdgeResult).includes('SURVEY_PARENT'));

  const malformedRowState = withSurveyAndRows({ rows: [data] });
  const rowParentEdge = malformedRowState.edges.find(
    edge => edge.relationship_definition_id === ROW_SURVEY_RELATIONSHIP,
  );
  rowParentEdge.relationship_definition_id = 'unknown-relationship';
  const malformedRowResult = auditSourceAgainstState(sourceRows(data), malformedRowState);
  assert.equal(malformedRowResult.readiness, 'BLOCKED');
  assert.ok(codes(malformedRowResult).includes('ROW_PARENT'));
});

test('vacant_wte omitted and vacant_wte zero are not treated as the same existing row', () => {
  const existing = rowData({ vacant_wte: 0 });
  const sourceData = rowData();
  delete sourceData.vacant_wte;
  const result = auditSourceAgainstState(
    sourceRows(sourceData),
    withSurveyAndRows({ rows: [existing] }),
  );

  assert.equal(result.readiness, 'BLOCKED');
  assert.equal(result.groups[0].rowsConflict, 1);
  assert.equal(result.rowPlan[0].action, 'conflict');
  assert.ok(codes(result).includes('ROW_MATCH'));
  assert.deepEqual(
    result.blockers.find(blocker => blocker.code === 'ROW_MATCH').sameSlotIds,
    ['row-existing-1'],
  );
});

test('unsupported dropdown values and trim-equivalent live options are blockers', () => {
  const unsupportedResult = auditSourceAgainstState(
    sourceRows(rowData({ grade: 'Band 99' })),
    baseState(),
  );
  assert.equal(unsupportedResult.readiness, 'BLOCKED');
  assert.ok(codes(unsupportedResult).includes('OPTION'));
  assert.equal(
    unsupportedResult.optionResolution.find(item => item.field === 'grade').error,
    'Unsupported live option',
  );

  const state = baseState();
  state.fields.find(fieldDefinition => fieldDefinition.name === 'grade').options = [
    { label: 'Band 7', value: 'Band 7' },
    { label: 'Band 7 (legacy)', value: 'Band 7 ' },
  ];
  const ambiguousResult = auditSourceAgainstState(sourceRows(rowData()), state);
  assert.equal(ambiguousResult.readiness, 'BLOCKED');
  assert.ok(codes(ambiguousResult).includes('OPTION'));
  assert.equal(
    ambiguousResult.optionResolution.find(item => item.field === 'grade').error,
    'Ambiguous live options',
  );
});

test('a canonical dropdown value with surrounding whitespace is blocked without rewriting the plan', () => {
  const state = baseState();
  state.fields.find(fieldDefinition => fieldDefinition.name === 'grade').options = ['Band 7 '];
  const data = rowData({ grade: 'Band 7 ' });
  const result = auditSourceAgainstState(sourceRows(data), state);

  assert.equal(result.readiness, 'BLOCKED');
  assert.ok(codes(result).includes('OPTION_WRITE_COMPATIBILITY'));
  assert.equal(result.rowPlan[0].data.grade, 'Band 7 ');
});

test('the clean fixture uses tenant-scoped custom-object relationship endpoints and no Row-to-Department edge', () => {
  const state = baseState();
  const result = auditSourceAgainstState(sourceRows(rowData()), state);

  assert.ok(result.relationships.every(definition =>
    definition.tenant_id === TENANT
    && definition.source_kind === 'custom_object'
    && definition.target_kind === 'custom_object',
  ));
  assert.equal(
    result.relationships.find(definition => definition.id === SURVEY_DEPARTMENT_RELATIONSHIP)
      .source_custom_object_id,
    SURVEY,
  );
  assert.equal(
    result.relationships.find(definition => definition.id === ROW_SURVEY_RELATIONSHIP)
      .target_custom_object_id,
    SURVEY,
  );
  assert.equal(result.counts.directRowDepartmentEdgesPlanned, 0);
});

test('resolveOption accepts exact values, rejects unsupported values, and exposes trim ambiguity', () => {
  const fieldDefinition = { options: [{ label: 'Band 7', value: 'Band 7' }] };
  assert.deepEqual(resolveOption(fieldDefinition, 'Band 7'), {
    value: 'Band 7',
    label: 'Band 7',
    match: 'exact-value',
  });
  assert.equal(resolveOption(fieldDefinition, 'Band 8').error, 'Unsupported live option');
  assert.equal(
    resolveOption({
      options: [
        { label: 'Band 7', value: 'Band 7' },
        { label: 'Band 7 old', value: 'Band 7 ' },
      ],
    }, 'Band 7').error,
    'Ambiguous live options',
  );
});