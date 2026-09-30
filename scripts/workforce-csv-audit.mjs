/** Pure, occurrence-preserving comparison. Never calls a database or importer. */
import { createHash } from 'node:crypto';
import { TENANT, SURVEY, ROW } from './workforce-readonly-state.mjs';

const active = x => !x.archived_at && (x.status === undefined || x.status === 'active');
const groupBy = (items, key) => {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
};
const rowKey = data => JSON.stringify([
  data.row_name, data.staff_group, data.grade, data.occupied_wte,
  Object.hasOwn(data, 'vacant_wte') ? ['present', data.vacant_wte] : ['absent'],
  data.legacy_vacancy_reported,
]);
const slotKey = data => JSON.stringify([data.row_name, data.staff_group, data.grade]);

export function resolveOption(field, supplied) {
  if (!Array.isArray(field?.options)) return { error: 'No live option array' };
  const options = field.options.map(o => typeof o === 'string' ? { label: o, value: o } : o);
  // Trim only at matching time. Never rewrite the live canonical stored value.
  const matches = options.filter(o => typeof o?.value === 'string' &&
    [o.value, o.label].some(v => typeof v === 'string' && v.trim() === supplied.trim()));
  if (matches.length !== 1) return { error: matches.length ? 'Ambiguous live options' : 'Unsupported live option' };
  return { value: matches[0].value, label: matches[0].label, match: matches[0].value === supplied ? 'exact-value' : 'unique-trimmed-label-or-value' };
}

export function auditSourceAgainstState(source, state) {
  const blockers = [];
  const add = (code, detail) => blockers.push({ code, ...detail });
  if (state.tenant?.id !== TENANT || !['BNMS', 'British Nuclear Medicine Society'].includes(state.tenant?.name)) {
    add('TENANT_IDENTITY', { message: 'Live tenant identity is not BNMS.' });
  }
  const objectSpecs = [
    [SURVEY, 'workforce_survey', 'Workforce survey'],
    [ROW, 'workforce_survey_row', 'Workforce Survey Row'],
  ];
  const departmentObjects = state.objects.filter(o => o.object_key === 'org_department');
  const departmentObject = departmentObjects[0];
  if (departmentObjects.length !== 1 || departmentObject.tenant_id !== TENANT || !active(departmentObject)) {
    add('DEPARTMENT_OBJECT', { message: 'Expected one active BNMS Department object.' });
  }
  for (const [id, key, label] of objectSpecs) {
    const matches = state.objects.filter(o => o.id === id || o.object_key === key);
    if (matches.length !== 1 || matches[0].id !== id || matches[0].object_key !== key
      || matches[0].singular_label !== label || matches[0].tenant_id !== TENANT || !active(matches[0])) {
      add('OBJECT_IDENTITY', { objectId: id, message: `Target ${key} identity/status drift.` });
    }
  }
  const specs = [
    ['Reporting_Year', SURVEY, 'survey_name', 'text', true],
    ['Reporting_Year (derived)', ROW, 'row_name', 'text', true],
    ['Staff_Group', ROW, 'staff_group', 'dropdown', true],
    ['Grade', ROW, 'grade', 'dropdown', true],
    ['Occupied_Nuclear_Medicine_WTE', ROW, 'occupied_wte', 'decimal', true],
    ['Not supplied — omit', ROW, 'vacant_wte', 'decimal', false],
    ['Legacy_Vacancy_Reported (blank → No)', ROW, 'legacy_vacancy_reported', 'dropdown', false],
  ];
  const mapping = specs.map(([header, objectId, name, type, required]) => {
    const matches = state.fields.filter(f => f.custom_object_id === objectId && f.name === name && f.is_active && !f.archived_at);
    const field = matches[0];
    const valid = matches.length === 1 && field.tenant_id === TENANT && field.entity_scope === 'custom_object'
      && field.field_type === type && field.is_required === required;
    if (!valid) add('FIELD_CONTRACT', { field: name, message: `Expected one active ${type} field, required=${required}.` });
    return { source: header, objectId, name, id: field?.id ?? null, type: field?.field_type ?? null,
      required: field?.is_required ?? null, label: field?.label ?? null, valid,
      options: field?.options ?? null, field };
  });
  const byName = new Map(mapping.map(m => [m.name, m]));
  const optionResolution = [];
  for (const name of ['staff_group', 'grade', 'legacy_vacancy_reported']) {
    for (const [value, rows] of groupBy(source.rows, r => r.data[name])) {
      const resolved = resolveOption(byName.get(name)?.field, value);
      const item = { field: name, supplied: value, count: rows.length, lines: rows.map(r => r.sourceRow), ...resolved };
      optionResolution.push(item);
      if (resolved.error) add('OPTION', { ...item, message: `${name}: ${JSON.stringify(value)} — ${resolved.error}` });
      else if (resolved.value !== resolved.value.trim()) add('OPTION_WRITE_COMPATIBILITY', { ...item,
        message: `${name}: canonical value ${JSON.stringify(resolved.value)} has surrounding whitespace. The normal record validator trims input before comparison, so this value cannot pass that path. Confirm a separately approved import validation path; do not change live options here.` });
    }
  }
  const canonicalRows = source.rows.map(row => {
    const data = { ...row.data };
    const issues = [];
    for (const name of ['staff_group', 'grade', 'legacy_vacancy_reported']) {
      const resolved = resolveOption(byName.get(name)?.field, data[name]);
      if (resolved.error) issues.push(`${name}: ${resolved.error}`);
      else {
        data[name] = resolved.value;
        if (resolved.value !== resolved.value.trim()) issues.push(`${name}: canonical option write-path compatibility`);
      }
    }
    for (const objectId of [SURVEY, ROW]) {
      const supplied = objectId === SURVEY ? { survey_name: source.reportingYear } : data;
      for (const field of state.fields.filter(f => f.custom_object_id === objectId && f.is_active && !f.archived_at)) {
        const value = supplied[field.name];
        if (field.tenant_id !== TENANT || field.entity_scope !== 'custom_object') issues.push(`Foreign field: ${field.name}`);
        if (field.is_required && (value === undefined || value === null || value === '')) issues.push(`Required field missing: ${field.name}`);
        if (typeof value === 'string' && ((Number.isInteger(field.min_length) && value.length < field.min_length)
          || (Number.isInteger(field.max_length) && value.length > field.max_length))) issues.push(`Text length: ${field.name}`);
      }
    }
    return { ...row, data, mappingIssues: issues, provisionalIdentity: createHash('sha256')
      .update(JSON.stringify([TENANT, ROW, source.fingerprint, row.sourceRow])).digest('hex') };
  });
  const requiredGaps = [...groupBy(canonicalRows.flatMap(r => r.mappingIssues.filter(x => x.startsWith('Required field')
    || x.startsWith('Foreign field') || x.startsWith('Text length'))
    .map(message => ({ message, sourceRow: r.sourceRow }))), x => x.message)]
    .map(([message, rows]) => ({ message, lines: rows.map(r => r.sourceRow) }));
  requiredGaps.forEach(g => add('REQUIRED_OR_VALUE', g));
  const relationshipSpecs = [
    ['workforce_survey_department', SURVEY, departmentObject?.id],
    ['workforce_survey_row_survey', ROW, SURVEY],
  ];
  const relationships = relationshipSpecs.map(([key, from, to]) => {
    const candidates = state.definitions.filter(d => d.relationship_key === key && active(d));
    const d = candidates[0];
    const valid = candidates.length === 1 && d.tenant_id === TENANT && d.source_kind === 'custom_object'
      && d.target_kind === 'custom_object' && d.source_custom_object_id === from && d.target_custom_object_id === to
      && d.cardinality === 'many_to_one' && d.is_required === true && d.show_on_source && d.edit_from_source;
    if (!valid) add('RELATIONSHIP_CONTRACT', { message: `${key} must be required many-to-one in its proposed direction.` });
    if (d && Object.keys(d.configuration || {}).length) {
      add('RELATIONSHIP_CONFIG_REVIEW', { message: `${key} has additional configuration requiring explicit review.`, configuration: d.configuration });
    }
    return { ...d, valid };
  });
  const [surveyDepartment, rowSurvey] = relationships;
  for (const d of state.definitions.filter(d => active(d) && d.is_required
    && [SURVEY, ROW].includes(d.source_custom_object_id))) {
    if (!relationships.some(r => r.id === d.id)) add('EXTRA_REQUIRED_RELATIONSHIP', { definitionId: d.id, message: d.relationship_key });
  }
  const records = new Map(state.records.map(r => [r.id, r]));
  const departments = new Map(state.departments.map(r => [r.id, r]));
  const deptStatus = id => {
    const d = departments.get(id);
    if (!d) return 'missing';
    if (d.tenant_id !== TENANT) return 'cross-tenant';
    if (d.custom_object_id !== departmentObject?.id) return 'wrong-object';
    if (d.archived_at) return 'archived';
    return 'active';
  };
  const activeEdges = state.edges.filter(active);
  const surveyRecords = state.records.filter(r => r.custom_object_id === SURVEY && active(r));
  const rowRecords = state.records.filter(r => r.custom_object_id === ROW && active(r));
  const deptEdges = id => activeEdges.filter(e => e.relationship_definition_id === surveyDepartment.id && e.source_record_id === id);
  const parentEdges = id => activeEdges.filter(e => e.relationship_definition_id === rowSurvey.id && e.source_record_id === id);
  const malformedSurveys = new Set();
  const malformedRows = new Set();
  const validEdge = (edge, definition, targetObject) => edge.tenant_id === TENANT
    && definition.source_kind === 'custom_object' && definition.target_kind === 'custom_object'
    && records.get(edge.source_record_id)?.tenant_id === TENANT
    && records.get(edge.source_record_id)?.custom_object_id === definition.source_custom_object_id
    && records.get(edge.target_record_id)?.tenant_id === TENANT
    && records.get(edge.target_record_id)?.custom_object_id === targetObject
    && active(records.get(edge.target_record_id));
  for (const s of surveyRecords) {
    const edges = deptEdges(s.id);
    if (s.tenant_id !== TENANT || edges.length !== 1 || !validEdge(edges[0], surveyDepartment, departmentObject?.id)) {
      malformedSurveys.add(s.id);
      add('SURVEY_PARENT', { recordId: s.id, message: `Existing survey has invalid Department linkage (${edges.length} edges).` });
    }
  }
  const directDefinitions = new Set(state.definitions.filter(d =>
    d.source_custom_object_id === ROW && d.target_custom_object_id === departmentObject?.id).map(d => d.id));
  for (const r of rowRecords) {
    const edges = parentEdges(r.id);
    const direct = activeEdges.filter(e => e.source_record_id === r.id && (directDefinitions.has(e.relationship_definition_id)
      || records.get(e.target_record_id)?.custom_object_id === departmentObject?.id));
    if (r.tenant_id !== TENANT || edges.length !== 1 || !validEdge(edges[0], rowSurvey, SURVEY)
      || malformedSurveys.has(edges[0]?.target_record_id) || direct.length) {
      malformedRows.add(r.id);
      add('ROW_PARENT', { recordId: r.id, message: `Existing row has invalid Survey lineage or direct Department links (${edges.length} parent, ${direct.length} direct).` });
    }
  }
  const groups = [];
  const rowPlan = [];
  for (const [departmentId, rows] of groupBy(canonicalRows, r => r.departmentId)) {
    const status = deptStatus(departmentId);
    const matching = surveyRecords.filter(s => s.data?.survey_name === source.reportingYear
      && deptEdges(s.id).some(e => e.target_record_id === departmentId));
    const archivedMatches = state.records.filter(s => s.custom_object_id === SURVEY && s.archived_at
      && s.data?.survey_name === source.reportingYear && state.edges.some(e =>
        e.relationship_definition_id === surveyDepartment.id && e.source_record_id === s.id && e.target_record_id === departmentId));
    const conflict = status !== 'active' || matching.length > 1 || matching.some(s => malformedSurveys.has(s.id))
      || archivedMatches.length > 0 || relationships.some(r => !r.valid);
    if (status !== 'active') add('DEPARTMENT', { departmentId, message: status, lines: rows.map(r => r.sourceRow) });
    if (matching.length > 1 || archivedMatches.length) add('SURVEY_MATCH', { departmentId,
      message: 'Ambiguous active or historical survey match; do not restore, merge or duplicate automatically.',
      activeIds: matching.map(x => x.id), archivedIds: archivedMatches.map(x => x.id) });
    const survey = matching.length === 1 ? matching[0] : null;
    const existingRows = survey ? rowRecords.filter(r => parentEdges(r.id).some(e => e.target_record_id === survey.id)) : [];
    const exactSource = groupBy(rows, r => rowKey(r.data));
    for (const row of rows) {
      const matches = existingRows.filter(r => rowKey(r.data) === rowKey(row.data));
      const slotMatches = existingRows.filter(r => slotKey(r.data) === slotKey(row.data));
      const historical = state.records.filter(r => r.custom_object_id === ROW && r.archived_at
        && rowKey(r.data) === rowKey(row.data) && survey && state.edges.some(e =>
          e.relationship_definition_id === rowSurvey.id && e.source_record_id === r.id && e.target_record_id === survey.id));
      const ambiguous = conflict || historical.length > 0 || matches.length > 1
        || (matches.length && exactSource.get(rowKey(row.data)).length > 1)
        || (!matches.length && slotMatches.length > 0) || matches.some(r => malformedRows.has(r.id));
      const action = ambiguous ? 'conflict' : matches.length === 1 ? 'reuse' : 'create';
      if (ambiguous && !conflict) add('ROW_MATCH', { departmentId, line: row.sourceRow,
        message: 'Existing overlap cannot be assigned to this source occurrence unambiguously.',
        matchIds: matches.map(x => x.id), sameSlotIds: slotMatches.map(x => x.id), archivedIds: historical.map(x => x.id) });
      rowPlan.push({ ...row, action, existingId: action === 'reuse' ? matches[0].id : null,
        surveyId: survey?.id ?? null, surveyEdgeAction: action, directDepartmentEdges: 0 });
    }
    const departmentRows = rowPlan.filter(r => r.departmentId === departmentId);
    groups.push({ departmentId, departmentName: records.get(departmentId)?.data?.name ?? null,
      reportingYear: source.reportingYear, departmentStatus: status, sourceRows: rows.length,
      sourceLines: rows.map(r => r.sourceRow), occupiedWte: rows.reduce((a, r) => a + r.occupiedHundredths, 0) / 100,
      surveyAction: conflict ? 'conflict' : survey ? 'reuse' : 'create',
      surveyId: survey?.id ?? null, surveyDepartmentEdgeAction: conflict ? 'conflict' : survey ? 'reuse' : 'create',
      rowsCreate: departmentRows.filter(r => r.action === 'create').length,
      rowsReuse: departmentRows.filter(r => r.action === 'reuse').length,
      rowsConflict: departmentRows.filter(r => r.action === 'conflict').length,
      rowsMappingBlocked: rows.filter(r => r.mappingIssues.length).length,
      existingRowsPreservedWithoutReuse: existingRows.filter(r => !departmentRows.some(p => p.existingId === r.id)).map(r => r.id) });
  }
  const outsideSurveys = surveyRecords.filter(s => !groups.some(g => g.surveyId === s.id)).map(s => ({
    id: s.id, reportingYear: s.data?.survey_name, departmentIds: deptEdges(s.id).map(e => e.target_record_id),
    rowIds: rowRecords.filter(r => parentEdges(r.id).some(e => e.target_record_id === s.id)).map(r => r.id),
    validLineage: !malformedSurveys.has(s.id), action: 'preserve',
  }));
  const count = (items, key, value) => items.filter(x => x[key] === value).length;
  const counts = {
    sourceGroups: groups.length, sourceOccurrences: rowPlan.length,
    departments: Object.fromEntries(['active', 'missing', 'archived', 'cross-tenant', 'wrong-object'].map(s => [s, count(groups, 'departmentStatus', s)])),
    surveys: Object.fromEntries(['create', 'reuse', 'conflict'].map(a => [a, count(groups, 'surveyAction', a)])),
    rows: Object.fromEntries(['create', 'reuse', 'conflict'].map(a => [a, count(rowPlan, 'action', a)])),
    surveyDepartmentEdges: Object.fromEntries(['create', 'reuse', 'conflict'].map(a => [a, count(groups, 'surveyDepartmentEdgeAction', a)])),
    rowSurveyEdges: Object.fromEntries(['create', 'reuse', 'conflict'].map(a => [a, count(rowPlan, 'surveyEdgeAction', a)])),
    directRowDepartmentEdgesPlanned: 0,
    mappingBlockedRows: canonicalRows.filter(r => r.mappingIssues.length).length,
    existingActiveSurveys: surveyRecords.length, existingActiveRows: rowRecords.length,
    existingArchivedSurveys: state.records.filter(r => r.custom_object_id === SURVEY && r.archived_at).length,
    existingArchivedRows: state.records.filter(r => r.custom_object_id === ROW && r.archived_at).length,
    outsideSurveysPreserved: outsideSurveys.length,
    outsideRowsPreserved: new Set(outsideSurveys.flatMap(s => s.rowIds)).size,
  };
  return { blockers, mapping: mapping.map(({ field, ...m }) => m), optionResolution, requiredGaps,
    departmentObject, relationships, groups, rowPlan, outsideSurveys, counts,
    importAuthorized: false, readiness: blockers.length ? 'BLOCKED' : 'AWAITING_SEPARATE_APPROVAL' };
}