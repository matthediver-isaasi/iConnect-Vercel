#!/usr/bin/env node
/**
 * Destination-pinned, dry-run-first rollout for the BNMS Department Current Set
 * form contract. This configures only the pinned form and its dedicated config
 * row; it never imports, edits, or archives Department/Workforce/Equipment data.
 *
 * Usage:
 *   node scripts/configure-department-current-set.mjs
 *   node scripts/configure-department-current-set.mjs --review=reports/current-set-review.json
 *   node scripts/configure-department-current-set.mjs --apply --review=reports/current-set-review.json
 *
 * --apply deliberately requires a separately reviewed dry-run report. The
 * migration creating department_current_set_config must be installed first.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import {
  CURRENT_SET_CONFIG_TABLE, FORM_FIELDS, FORM_ID, OBJECT_FIELD_NAMES, OBJECT_IDS,
  RELATIONSHIP_IDS, TENANT_ID, buildDepartmentCurrentSetConfig, fingerprint,
  formCurrentSetCandidate, validateCurrentSetConfig,
} from './department-current-set-config.mjs';
import { FILE as WORKFORCE_SOURCE_FILE, parseSource } from './workforce-csv-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const APPLICATION_PUBLISHED = args.includes('--application-published');
const reviewArgument = args.find(argument => argument.startsWith('--review='));
const reportArgument = args.find(argument => argument.startsWith('--report='));
if (args.some(argument => argument !== '--apply' && argument !== '--application-published'
  && !argument.startsWith('--review=') && !argument.startsWith('--report='))) {
  throw new Error('Supported arguments are --apply, --application-published, --review=<review.json>, and --report=<report.json>.');
}
if (APPLY && !reviewArgument) throw new Error('--apply requires an explicit reviewed dry-run report via --review=<path>.');
if (APPLICATION_PUBLISHED && !APPLY) throw new Error('--application-published is only meaningful with --apply.');
if (APPLY && !APPLICATION_PUBLISHED) {
  throw new Error('--apply requires --application-published after the new API/client picker and auth-reset changes are live.');
}

const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const active = row => row && row.archived_at == null;
const REQUIRED_AUTHENTICATED_RPCS = Object.freeze([
  'public.department_current_set_lock(uuid)',
  'public.department_current_set_load_authenticated(uuid,uuid,uuid,uuid,text)',
  'public.department_current_set_reconcile_authenticated(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)',
  'public.department_current_set_assert_authorized(uuid,uuid,uuid,jsonb)',
]);
const DESTINATION_CA_URL =
  'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt';
const DESTINATION_PROJECT_SUFFIX = '.lvmzliemqnieeoruhkik';
const relativePath = input => {
  const result = path.resolve(ROOT, input);
  check(result.startsWith(`${ROOT}${path.sep}`), 'Report paths must remain inside the workspace.');
  return result;
};
const same = (left, right) => fingerprint({ value: left }) === fingerprint({ value: right });

async function pages(queryBuilder, label) {
  const rows = [];
  const seen = new Set();
  let total;
  for (;;) {
    const { data, error, count } = await queryBuilder
      .order('id', { ascending: true })
      .range(rows.length, rows.length + 499);
    if (error) fail(`${label} read failed: ${error.message || error}`);
    if (!Array.isArray(data) || !Number.isSafeInteger(count)) fail(`${label} did not return exact pagination metadata.`);
    if (total !== undefined && count !== total) fail(`${label} changed during pagination; rerun the dry run.`);
    total = count;
    for (const row of data) {
      if (!row?.id || seen.has(row.id)) fail(`${label} pagination repeated or omitted a record ID.`);
      seen.add(row.id);
      rows.push(row);
    }
    if (rows.length === total) return rows;
    if (!data.length || rows.length > total) fail(`${label} pagination was incomplete.`);
  }
}

async function maybeConfig(db) {
  const { data, error } = await db.from(CURRENT_SET_CONFIG_TABLE)
    .select('tenant_id,form_id,config')
    .eq('tenant_id', TENANT_ID).eq('form_id', FORM_ID).maybeSingle();
  if (!error) return { schemaReady: true, row: data || null };
  // PostgREST reports an absent migration as a relation/schema cache error.
  if (/relation|table|schema cache|does not exist/i.test(error.message || '')) {
    return { schemaReady: false, row: null };
  }
  fail(`Current-set configuration read failed: ${error.message || error}`);
}

function recordCounts(records, edges, members) {
  const recordById = new Map(records.map(record => [record.id, record]));
  const edgesByDefinition = new Map();
  for (const edge of edges.filter(active)) {
    const list = edgesByDefinition.get(edge.relationship_definition_id) || [];
    list.push(edge);
    edgesByDefinition.set(edge.relationship_definition_id, list);
  }
  const edgesFor = id => edgesByDefinition.get(id) || [];
  const currentRows = records.filter(record => active(record) && record.custom_object_id === OBJECT_IDS.workforceRow);
  const currentEquipment = records.filter(record => active(record) && record.custom_object_id === OBJECT_IDS.equipment);
  const activeDepartments = new Set(records.filter(record => active(record)
    && record.custom_object_id === OBJECT_IDS.department).map(record => record.id));
  const workforceByDepartment = new Map();
  const workforceDepartmentEdges = new Map();
  for (const edge of edgesFor(RELATIONSHIP_IDS.workforceDepartment)) {
    const row = recordById.get(edge.source_record_id);
    if (!row || !active(row) || row.custom_object_id !== OBJECT_IDS.workforceRow
      || !activeDepartments.has(edge.target_record_id)) continue;
    workforceByDepartment.set(edge.target_record_id, (workforceByDepartment.get(edge.target_record_id) || 0) + 1);
    workforceDepartmentEdges.set(row.id, (workforceDepartmentEdges.get(row.id) || 0) + 1);
  }
  const equipmentByDepartment = new Map();
  const equipmentDepartmentEdges = new Map();
  const equipmentTypeEdges = new Map();
  const equipmentModelEdges = new Map();
  const equipmentTypes = new Map();
  const equipmentModels = new Map();
  const modelTypes = new Map();
  for (const edge of edgesFor(RELATIONSHIP_IDS.equipmentDepartment)) {
    const equipment = recordById.get(edge.source_record_id);
    if (!equipment || !active(equipment) || !activeDepartments.has(edge.target_record_id)) continue;
    equipmentByDepartment.set(edge.target_record_id, (equipmentByDepartment.get(edge.target_record_id) || 0) + 1);
    equipmentDepartmentEdges.set(equipment.id, (equipmentDepartmentEdges.get(equipment.id) || 0) + 1);
  }
  for (const edge of edgesFor(RELATIONSHIP_IDS.equipmentType)) {
    if (active(recordById.get(edge.source_record_id))) {
      equipmentTypeEdges.set(edge.source_record_id, (equipmentTypeEdges.get(edge.source_record_id) || 0) + 1);
      equipmentTypes.set(edge.source_record_id, edge.target_record_id);
    }
  }
  for (const edge of edgesFor(RELATIONSHIP_IDS.equipmentModel)) {
    if (active(recordById.get(edge.source_record_id))) {
      equipmentModelEdges.set(edge.source_record_id, (equipmentModelEdges.get(edge.source_record_id) || 0) + 1);
      equipmentModels.set(edge.source_record_id, edge.target_record_id);
    }
  }
  for (const edge of edgesFor(RELATIONSHIP_IDS.modelType)) {
    if (!active(edge)) continue;
    const types = modelTypes.get(edge.source_record_id) || new Set();
    types.add(edge.target_record_id);
    modelTypes.set(edge.source_record_id, types);
  }
  const respondentEdgesByDepartment = new Map();
  for (const edge of edgesFor(RELATIONSHIP_IDS.departmentRespondent)) {
    if (!activeDepartments.has(edge.source_record_id)
      || edge.field_values?.survey_respondent !== true) continue;
    const list = respondentEdgesByDepartment.get(edge.source_record_id) || [];
    list.push(edge.target_record_id);
    respondentEdgesByDepartment.set(edge.source_record_id, list);
  }
  const memberById = new Map((members || []).map(member => [member.id, member]));
  const respondentIds = [...respondentEdgesByDepartment.values()].flat();
  const unsuitableRespondents = respondentIds.filter(id => {
    const member = memberById.get(id);
    return !member || member.login_enabled === false || member.membership_paused === true
      || (String(member.email || '').startsWith('deleted_') && String(member.email || '').endsWith('@deleted.local'));
  });
  return {
    activeDepartments: activeDepartments.size,
    activeWorkforceRows: currentRows.length,
    activeEquipment: currentEquipment.length,
    maximumWorkforceRowsForOneDepartment: Math.max(0, ...workforceByDepartment.values()),
    maximumEquipmentRowsForOneDepartment: Math.max(0, ...equipmentByDepartment.values()),
    workforceRowsWithoutExactlyOneDepartment: currentRows.filter(row => (workforceDepartmentEdges.get(row.id) || 0) !== 1).length,
    equipmentWithoutExactlyOneDepartment: currentEquipment.filter(row => (equipmentDepartmentEdges.get(row.id) || 0) !== 1).length,
    equipmentWithoutExactlyOneType: currentEquipment.filter(row => (equipmentTypeEdges.get(row.id) || 0) !== 1).length,
    equipmentWithMultipleModels: currentEquipment.filter(row => (equipmentModelEdges.get(row.id) || 0) > 1).length,
    equipmentModelTypeMismatches: currentEquipment.filter(row => {
      const model = equipmentModels.get(row.id);
      const type = equipmentTypes.get(row.id);
      return model && type && !modelTypes.get(model)?.has(type);
    }).length,
    existingEquipmentBlankSerial: currentEquipment.filter(row => !String(row.data?.serial_number ?? '').trim()).length,
    existingEquipmentMissingInstallationYear: currentEquipment.filter(row => row.data?.year_installed === null || row.data?.year_installed === undefined || row.data?.year_installed === '').length,
    respondentAssignments: {
      departmentsWithExactlyOneAssignedRespondent: [...activeDepartments].filter(id =>
        (respondentEdgesByDepartment.get(id) || []).length === 1).length,
      departmentsWithoutAssignedRespondent: [...activeDepartments].filter(id =>
        (respondentEdgesByDepartment.get(id) || []).length === 0).length,
      departmentsWithMultipleAssignedRespondents: [...activeDepartments].filter(id =>
        (respondentEdgesByDepartment.get(id) || []).length > 1).length,
      assignedRespondentEdges: respondentIds.length,
      assignedRespondentsUnavailableOrLoginIneligible: unsuitableRespondents.length,
    },
  };
}

function departmentOrganisationSuitability({
  records, definitions, parentEdges, respondentEdges, members, organizations,
}) {
  const activeDepartmentIds = new Set(records.filter(record => active(record)
    && record.custom_object_id === OBJECT_IDS.department).map(record => record.id));
  const strictDefinitions = definitions.filter(definition =>
    definition.tenant_id === TENANT_ID && active(definition) && definition.status === 'active'
      && definition.relationship_key === 'organisation' && definition.is_required === true
      && definition.source_kind === 'custom_object'
      && definition.source_custom_object_id === OBJECT_IDS.department
      && definition.target_kind === 'organization'
      && definition.target_custom_object_id == null
      && definition.cardinality === 'many_to_one');
  const strictDefinition = strictDefinitions.length === 1 ? strictDefinitions[0] : null;
  const parentByDepartment = new Map();
  if (strictDefinition) {
    for (const edge of parentEdges.filter(active)) {
      if (edge.relationship_definition_id !== strictDefinition.id || !activeDepartmentIds.has(edge.source_record_id)) continue;
      const list = parentByDepartment.get(edge.source_record_id) || [];
      list.push(edge.target_record_id);
      parentByDepartment.set(edge.source_record_id, list);
    }
  }
  const organizationsById = new Map(organizations.map(organization => [organization.id, organization]));
  const membersById = new Map(members.map(member => [member.id, member]));
  const respondentByDepartment = new Map();
  // The preflight's selected edge set includes the pinned respondent definition.
  // Reuse it from the caller rather than reading an unscoped member relationship.
  for (const edge of respondentEdges.filter(active)) {
    if (edge.relationship_definition_id !== RELATIONSHIP_IDS.departmentRespondent
      || edge.field_values?.survey_respondent !== true || !activeDepartmentIds.has(edge.source_record_id)) continue;
    const list = respondentByDepartment.get(edge.source_record_id) || [];
    list.push(edge.target_record_id);
    respondentByDepartment.set(edge.source_record_id, list);
  }
  let exactlyOneValidParent = 0;
  let exactlyOneRespondentSameOrganisation = 0;
  let respondentUnavailableOrOtherOrganisation = 0;
  for (const departmentId of activeDepartmentIds) {
    const parents = parentByDepartment.get(departmentId) || [];
    const parentOrganizationId = parents[0];
    const parentValid = parents.length === 1
      && organizationsById.get(parentOrganizationId)?.tenant_id === TENANT_ID;
    if (parentValid) exactlyOneValidParent += 1;
    const respondents = respondentByDepartment.get(departmentId) || [];
    if (respondents.length !== 1) continue;
    const member = membersById.get(respondents[0]);
    if (parentValid && member?.tenant_id === TENANT_ID
      && member.organization_id === parentOrganizationId) {
      exactlyOneRespondentSameOrganisation += 1;
    } else {
      respondentUnavailableOrOtherOrganisation += 1;
    }
  }
  return {
    strictOrganisationParentDefinitions: strictDefinitions.length,
    strictOrganisationParentDefinitionId: strictDefinition?.id || null,
    departmentsWithExactlyOneValidOrganisationParent: exactlyOneValidParent,
    departmentsWithoutExactlyOneValidOrganisationParent: activeDepartmentIds.size - exactlyOneValidParent,
    departmentsWithExactlyOneRespondentInSameOrganisation: exactlyOneRespondentSameOrganisation,
    departmentsWithOneRespondentUnavailableOrOtherOrganisation: respondentUnavailableOrOtherOrganisation,
    handling: 'Informational only, not an access restriction: explicit Department respondent assignment permits cross-organisation access. Rollout does not alter organisation or respondent assignments.',
  };
}

function verifyForm(form, canonicalFields = []) {
  check(form?.id === FORM_ID && form.tenant_id === TENANT_ID, 'Pinned form identity drifted.');
  check(form.form_type === 'survey', 'Pinned form is no longer a survey.');
  check(form.is_active === true, 'Pinned form is not active.');
  const candidate = formCurrentSetCandidate(form, { canonicalFields });
  const equipment = candidate.fields.find(field => field.id === FORM_FIELDS.equipmentContainer);
  const children = new Map(equipment.child_fields.map(field => [field.id, field]));
  check(children.get(FORM_FIELDS.equipment.serialNumber)?.type === 'text'
    && children.get(FORM_FIELDS.equipment.serialNumber)?.required === true
    && children.get(FORM_FIELDS.equipment.serialNumber)?.unique_across_rows === true,
  'Equipment serial field must remain required and unique on the form.');
  check(children.get(FORM_FIELDS.equipment.installationYear)?.required === true,
    'Installation year must remain required on the form.');
  check(equipment.max_rows === 100, 'Candidate equipment row limit did not reach supported maximum.');
  check(candidate.fields.find(field => field.id === FORM_FIELDS.workforceContainer)?.max_rows === 100,
    'Candidate workforce row limit did not reach supported maximum.');
  const constraints = [FORM_FIELDS.workforceContainer, FORM_FIELDS.equipmentContainer].map(id => {
    const container = form.fields.find(field => field?.id === id);
    const childFields = Array.isArray(container?.child_fields) ? container.child_fields : [];
    return {
      containerId: id,
      min_rows: container?.min_rows ?? null,
      first_row_required: container?.first_row_required ?? null,
      required: container?.required ?? null,
      requiredChildHeaders: childFields.filter(field => field?.required === true).map(field => ({
        id: field.id, label: field.label ?? null, type: field.type ?? null,
      })),
    };
  });
  for (const constraint of constraints) {
    check((constraint.min_rows === null || constraint.min_rows === 0)
      && constraint.first_row_required !== true && constraint.required !== true,
    `Repeatable container ${constraint.containerId} blocks an intentional empty current set; refusing to alter user-owned constraints without an explicit current-set override.`);
  }
  return { candidate, constraints };
}

function verifyMetadata({ objects, fields, definitions, counts }) {
  const requiredObjects = [
    [OBJECT_IDS.department, 'org_department'], [OBJECT_IDS.workforceRow, 'workforce_survey_row'],
    [OBJECT_IDS.equipment, 'equipment_register'],
    [OBJECT_IDS.equipmentType, 'equipment_type'], [OBJECT_IDS.equipmentModel, 'equipment_model'],
  ];
  for (const [id, key] of requiredObjects) {
    const matches = objects.filter(object => object.id === id);
    check(matches.length === 1 && matches[0].tenant_id === TENANT_ID && matches[0].object_key === key && active(matches[0])
      && matches[0].status === 'active', `Pinned ${key} object metadata drifted.`);
  }
  const expectedDefinitions = [
    [RELATIONSHIP_IDS.equipmentDepartment, OBJECT_IDS.equipment, OBJECT_IDS.department],
    [RELATIONSHIP_IDS.equipmentType, OBJECT_IDS.equipment, OBJECT_IDS.equipmentType],
    [RELATIONSHIP_IDS.equipmentModel, OBJECT_IDS.equipment, OBJECT_IDS.equipmentModel],
    [RELATIONSHIP_IDS.modelType, OBJECT_IDS.equipmentModel, OBJECT_IDS.equipmentType],
    [RELATIONSHIP_IDS.workforceDepartment, OBJECT_IDS.workforceRow, OBJECT_IDS.department],
  ];
  for (const [id, source, target] of expectedDefinitions) {
    const definition = definitions.find(item => item.id === id);
    check(definition && definition.tenant_id === TENANT_ID && active(definition) && definition.status === 'active'
      && definition.source_custom_object_id === source && definition.target_custom_object_id === target,
    `Pinned relationship ${id} metadata drifted.`);
  }
  const directWorkforce = definitions.find(item => item.id === RELATIONSHIP_IDS.workforceDepartment);
  check(directWorkforce.relationship_key === 'workforce_survey_row_department'
    && directWorkforce.cardinality === 'many_to_one' && directWorkforce.is_required === true,
  'Pinned direct Workforce Row → Department relationship metadata drifted.');
  const respondent = definitions.find(item => item.id === RELATIONSHIP_IDS.departmentRespondent);
  check(respondent && active(respondent) && respondent.status === 'active'
    && respondent.tenant_id === TENANT_ID && respondent.relationship_key === 'members',
  'Pinned Department respondent relationship metadata drifted.');
  const respondentField = (respondent.configuration?.relationship_fields
    || respondent.configuration?.relationshipFields || [])
    .find(field => field?.id === 'edf1fbf8-76f7-4455-a7e2-f0f45db57b43');
  check(respondentField?.key === 'survey_respondent' && respondentField?.type === 'boolean',
    'Pinned Department respondent boolean field metadata drifted.');
  const all = new Map(fields.map(field => [`${field.custom_object_id}:${field.name}`, field]));
  for (const [object, names] of [
    [OBJECT_IDS.workforceRow, Object.values(OBJECT_FIELD_NAMES.workforceRow)],
    [OBJECT_IDS.equipment, Object.values(OBJECT_FIELD_NAMES.equipment)],
  ]) {
    for (const name of names) {
      const field = all.get(`${object}:${name}`);
      check(field && field.tenant_id === TENANT_ID && field.is_active === true, `Pinned field ${name} metadata drifted.`);
    }
  }
  check(counts.workforceRowsWithoutExactlyOneDepartment === 0,
    'A current workforce row has ambiguous or missing direct Department ownership; refusing rollout.');
  check(counts.maximumWorkforceRowsForOneDepartment <= 100,
    'A Department exceeds the supported 100 workforce-row limit; refusing rollout.');
  // These are pre-existing legacy-record observations, not configuration drift.
  // The rollout does not repair, archive, or infer missing edges. The trusted
  // server operation preserves valid blanks and rejects forged associations.
  check(counts.maximumEquipmentRowsForOneDepartment <= 100,
    'A Department exceeds the supported 100 equipment-row limit; refusing rollout.');
}

function verifyCurrentValues({ records, fields }) {
  const byObjectAndName = new Map(fields.map(field => [`${field.custom_object_id}:${field.name}`, field]));
  const valuesFor = (objectId, fieldName) => new Set((byObjectAndName.get(`${objectId}:${fieldName}`)?.options || [])
    .map(option => typeof option === 'object' ? option.value : option));
  const staffGroups = valuesFor(OBJECT_IDS.workforceRow, 'staff_group');
  const grades = valuesFor(OBJECT_IDS.workforceRow, 'grade');
  const serviceStates = valuesFor(OBJECT_IDS.equipment, 'still_in_service');
  check(staffGroups.size > 0 && grades.size > 0 && serviceStates.size > 0,
    'Canonical workforce or equipment choice metadata is missing.');
  for (const record of records.filter(record => active(record) && record.custom_object_id === OBJECT_IDS.workforceRow)) {
    if (record.data?.staff_group !== undefined) check(staffGroups.has(record.data.staff_group),
      'A current workforce Staff group is not an exact canonical option.');
    if (record.data?.grade !== undefined) check(grades.has(record.data.grade),
      'A current workforce Grade is not an exact canonical option.');
  }
  for (const record of records.filter(record => active(record) && record.custom_object_id === OBJECT_IDS.equipment)) {
    for (const key of ['year_installed', 'year_decommissioned']) {
      const value = record.data?.[key];
      if (value === undefined || value === null || value === '') continue;
      check(Number.isInteger(Number(value)) && /^\d{4}$/.test(String(value)),
        `An existing equipment ${key} is not a whole four-digit year.`);
    }
    const state = record.data?.still_in_service;
    if (state !== undefined && state !== null && state !== '') check(serviceStates.has(state),
      'An existing equipment service state is not an exact canonical option.');
  }
}

function optionValues(options) {
  return (options || []).map(option => typeof option === 'object' ? option.value : option);
}

function verifyFormChoiceCompatibility({ form, fields }) {
  const canonical = new Map(fields.map(field => [`${field.custom_object_id}:${field.name}`, field]));
  const workforce = form.fields.find(field => field?.id === FORM_FIELDS.workforceContainer);
  const equipment = form.fields.find(field => field?.id === FORM_FIELDS.equipmentContainer);
  const children = new Map([
    ...(workforce?.child_fields || []),
    ...(equipment?.child_fields || []),
  ].map(field => [field.id, field]));
  const pairs = [
    [FORM_FIELDS.workforce.staffGroup, OBJECT_IDS.workforceRow, 'staff_group'],
    [FORM_FIELDS.workforce.grade, OBJECT_IDS.workforceRow, 'grade'],
    [FORM_FIELDS.equipment.stillInService, OBJECT_IDS.equipment, 'still_in_service'],
  ];
  for (const [formFieldId, objectId, fieldName] of pairs) {
    const formField = children.get(formFieldId);
    const objectField = canonical.get(`${objectId}:${fieldName}`);
    check(formField?.type === 'select' && objectField?.field_type === 'dropdown',
      `Form/object dropdown type drifted for ${fieldName}.`);
    const saved = optionValues(formField.options);
    const approved = optionValues(objectField.options);
    check(saved.length > 0 && new Set(saved).size === saved.length
      && approved.length > 0 && new Set(approved).size === approved.length
      && saved.length === approved.length && saved.every(value => approved.includes(value)),
    `Form dropdown options drifted from canonical ${fieldName} options.`);
  }
  return { checked: pairs.map(([, , fieldName]) => fieldName), exactCanonicalOptionSets: true };
}

async function plannedWorkforceCapacity(records, edges) {
  const source = parseSource(await readFile(WORKFORCE_SOURCE_FILE));
  const currentByDepartment = new Map();
  const recordsById = new Map(records.map(record => [record.id, record]));
  for (const edge of edges.filter(edge => active(edge)
    && edge.relationship_definition_id === RELATIONSHIP_IDS.workforceDepartment)) {
    const row = recordsById.get(edge.source_record_id);
    if (row?.custom_object_id === OBJECT_IDS.workforceRow && active(row)) {
      currentByDepartment.set(edge.target_record_id, (currentByDepartment.get(edge.target_record_id) || 0) + 1);
    }
  }
  const plannedByDepartment = new Map();
  for (const row of source.rows) {
    plannedByDepartment.set(row.departmentId, (plannedByDepartment.get(row.departmentId) || 0) + 1);
  }
  const projected = new Map(currentByDepartment);
  for (const [departmentId, rows] of plannedByDepartment) {
    projected.set(departmentId, (projected.get(departmentId) || 0) + rows);
  }
  const maximum = values => Math.max(0, ...values.values());
  const evidence = {
    sourceSha256: source.fingerprint,
    sourceRows: source.rows.length,
    sourceDepartments: plannedByDepartment.size,
    maximumSourceRowsForOneDepartment: maximum(plannedByDepartment),
    maximumExistingRowsForOneDepartment: maximum(currentByDepartment),
    maximumProjectedRowsForOneDepartment: maximum(projected),
  };
  check(evidence.maximumProjectedRowsForOneDepartment <= 100,
    'The approved direct workforce source plus existing rows exceeds the supported 100-row form limit.');
  return evidence;
}

function reviewedScope({
  form, objects, fields, definitions, records, edges, members, config,
  workforceImportCapacity, organisationDefinitions, organisationParentEdges, organisations,
}) {
  return {
    form: {
      id: form.id, tenant_id: form.tenant_id, is_active: form.is_active,
      require_authentication: form.require_authentication, access_policy: form.access_policy,
      fields: form.fields, survey_settings: form.survey_settings,
    },
    objects: objects.map(row => ({ id: row.id, tenant_id: row.tenant_id, object_key: row.object_key, status: row.status, archived_at: row.archived_at })),
    fields: fields.map(row => ({ id: row.id, tenant_id: row.tenant_id, custom_object_id: row.custom_object_id, name: row.name, field_type: row.field_type, is_active: row.is_active, is_required: row.is_required, options: row.options })),
    definitions: definitions.map(row => ({ id: row.id, tenant_id: row.tenant_id, relationship_key: row.relationship_key, source_kind: row.source_kind, source_custom_object_id: row.source_custom_object_id, target_kind: row.target_kind, target_custom_object_id: row.target_custom_object_id, status: row.status, archived_at: row.archived_at, is_required: row.is_required, cardinality: row.cardinality, configuration: row.configuration })),
    records: records.map(row => ({ id: row.id, tenant_id: row.tenant_id, custom_object_id: row.custom_object_id, archived_at: row.archived_at, data: row.data })),
    edges: edges.map(row => ({ id: row.id, tenant_id: row.tenant_id, relationship_definition_id: row.relationship_definition_id, source_record_id: row.source_record_id, target_record_id: row.target_record_id, archived_at: row.archived_at, field_values: row.field_values })),
    members: members.map(row => ({ id: row.id, tenant_id: row.tenant_id, login_enabled: row.login_enabled, membership_paused: row.membership_paused, email: row.email, organization_id: row.organization_id })),
    organisationDefinitions: organisationDefinitions.map(row => ({
      id: row.id, tenant_id: row.tenant_id, relationship_key: row.relationship_key,
      source_kind: row.source_kind, source_custom_object_id: row.source_custom_object_id,
      target_kind: row.target_kind, target_custom_object_id: row.target_custom_object_id,
      status: row.status, archived_at: row.archived_at, is_required: row.is_required,
      cardinality: row.cardinality,
    })),
    organisationParentEdges: organisationParentEdges.map(row => ({
      id: row.id, tenant_id: row.tenant_id, relationship_definition_id: row.relationship_definition_id,
      source_record_id: row.source_record_id, target_record_id: row.target_record_id,
      archived_at: row.archived_at,
    })),
    organisations: organisations.map(row => ({ id: row.id, tenant_id: row.tenant_id })),
    currentSetConfig: config?.row?.config || null,
    workforceImportCapacity,
  };
}

async function preflight(db) {
  const [formResult, objects, fields, definitions, records, edges, config, organisationDefinitions] = await Promise.all([
    db.from('form').select('*').eq('id', FORM_ID).eq('tenant_id', TENANT_ID).maybeSingle(),
    pages(db.from('custom_object_definition').select('id,tenant_id,object_key,status,archived_at', { count: 'exact' }).eq('tenant_id', TENANT_ID)
      .in('id', Object.values(OBJECT_IDS)), 'Object definitions'),
    pages(db.from('preference_field').select('id,tenant_id,custom_object_id,name,label,field_type,is_active,is_required,options', { count: 'exact' }).eq('tenant_id', TENANT_ID)
      .in('custom_object_id', [OBJECT_IDS.workforceRow, OBJECT_IDS.equipment]), 'Object fields'),
    pages(db.from('custom_object_relationship_definition').select('id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,status,archived_at,is_required,cardinality,configuration', { count: 'exact' })
      .eq('tenant_id', TENANT_ID).in('id', Object.values(RELATIONSHIP_IDS)), 'Relationship definitions'),
    pages(db.from('custom_object_record').select('id,tenant_id,custom_object_id,archived_at,data', { count: 'exact' }).eq('tenant_id', TENANT_ID)
      .in('custom_object_id', [OBJECT_IDS.department, OBJECT_IDS.workforceRow, OBJECT_IDS.equipment]), 'Current-set records'),
    pages(db.from('custom_object_relationship').select('id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,field_values', { count: 'exact' }).eq('tenant_id', TENANT_ID)
      .in('relationship_definition_id', Object.values(RELATIONSHIP_IDS)), 'Current-set relationships'),
    maybeConfig(db),
    pages(db.from('custom_object_relationship_definition').select('id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,status,archived_at,is_required,cardinality', { count: 'exact' })
      .eq('tenant_id', TENANT_ID).eq('relationship_key', 'organisation')
      .eq('source_custom_object_id', OBJECT_IDS.department), 'Department organisation relationship definitions'),
  ]);
  if (formResult.error) fail(`Pinned form read failed: ${formResult.error.message || formResult.error}`);
  const respondentMemberIds = [...new Set(edges.filter(edge => active(edge)
    && edge.relationship_definition_id === RELATIONSHIP_IDS.departmentRespondent
    && edge.field_values?.survey_respondent === true).map(edge => edge.target_record_id))];
  const members = respondentMemberIds.length
    ? await pages(db.from('member').select('id,tenant_id,login_enabled,membership_paused,email,organization_id', { count: 'exact' })
      .in('id', respondentMemberIds), 'Assigned respondent members')
    : [];
  const organisationDefinitionIds = organisationDefinitions.map(definition => definition.id);
  const organisationParentEdges = organisationDefinitionIds.length
    ? await pages(db.from('custom_object_relationship').select('id,tenant_id,relationship_definition_id,source_record_id,target_record_id,archived_at,field_values', { count: 'exact' })
      .eq('tenant_id', TENANT_ID).in('relationship_definition_id', organisationDefinitionIds),
    'Department organisation relationships')
    : [];
  const organisationIds = [...new Set([
    ...organisationParentEdges.filter(active).map(edge => edge.target_record_id),
    ...members.map(member => member.organization_id).filter(Boolean),
  ])];
  const organisations = organisationIds.length
    ? await pages(db.from('organization').select('id,tenant_id', { count: 'exact' })
      .in('id', organisationIds), 'Department respondent organisations')
    : [];
  const formSafety = verifyForm(formResult.data, fields);
  const counts = recordCounts(records, edges, members);
  const organisationSuitability = departmentOrganisationSuitability({
    records, definitions: organisationDefinitions, parentEdges: organisationParentEdges,
    respondentEdges: edges, members, organizations: organisations,
  });
  verifyMetadata({ objects, fields, definitions, counts });
  verifyCurrentValues({ records, fields });
  const formChoiceCompatibility = verifyFormChoiceCompatibility({ form: formSafety.candidate, fields });
  const workforceImportCapacity = await plannedWorkforceCapacity(records, edges);
  const desiredConfig = buildDepartmentCurrentSetConfig(formSafety.candidate);
  if (config.row) check(validateCurrentSetConfig(config.row.config, formSafety.candidate), 'Existing current-set configuration drifted; refusing replacement.');
  const scope = reviewedScope({
    form: formResult.data, objects, fields, definitions, records, edges, members, config,
    workforceImportCapacity, organisationDefinitions, organisationParentEdges, organisations,
  });
  return {
    form: formResult.data, candidate: formSafety.candidate, containerConstraints: formSafety.constraints,
    objects, fields, definitions, records, edges, members, config, desiredConfig, counts,
    organisationDefinitions, organisationParentEdges, organisations, organisationSuitability,
    formChoiceCompatibility, workforceImportCapacity, scope,
    fingerprint: fingerprint(scope),
  };
}

async function readReview(argument) {
  const report = JSON.parse(await readFile(relativePath(argument.slice('--review='.length)), 'utf8'));
  check(report?.review_version === 1 && report?.tenantId === TENANT_ID && report?.formId === FORM_ID
    && typeof report?.preflightFingerprint === 'string', 'Review report is not a valid pinned current-set preflight.');
  return report;
}

async function writeBackup(state) {
  const directory = path.join(ROOT, '.local', 'backups');
  await mkdir(directory, { recursive: true });
  const filename = `configure-department-current-set-${FORM_ID}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const backup = path.join(directory, filename);
  await writeFile(backup, `${JSON.stringify({
    snapshot_version: 1, captured_at: new Date().toISOString(),
    form: state.form, current_set_config: state.config.row,
    preflight_fingerprint: state.fingerprint,
  }, null, 2)}\n`);
  return backup;
}

async function destinationSqlClient() {
  const connectionString = process.env.DEST_DATABASE_URL;
  check(connectionString, 'DEST_DATABASE_URL is required for the guarded atomic apply.');
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
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) destination.searchParams.delete(key);
  const caResponse = await fetch(DESTINATION_CA_URL);
  check(caResponse.ok, `Destination CA download failed with HTTP ${caResponse.status}.`);
  const ca = await caResponse.text();
  check(ca.includes('BEGIN CERTIFICATE'), 'Destination CA download was not a PEM certificate.');
  return new pg.Client({
    connectionString: destination.toString(),
    ssl: { rejectUnauthorized: true, ca, servername: destination.hostname },
  });
}

async function applyAtomically(state) {
  // Config and form changes commit together. The database function's trigger
  // takes this same scoped advisory lock for later Data Studio changes; direct
  // record reconciliation remains its own atomic server-side RPC.
  check(state.config.schemaReady, `Migration has not created ${CURRENT_SET_CONFIG_TABLE}; install the reviewed migration first.`);
  check(!state.config.row || validateCurrentSetConfig(state.config.row.config, state.candidate),
    'Existing current-set configuration drifted; refusing replacement.');
  const backupPath = await writeBackup(state);
  const client = await destinationSqlClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const missingRpcs = await client.query(
      'SELECT signature FROM unnest($1::text[]) AS signature WHERE to_regprocedure(signature) IS NULL',
      [REQUIRED_AUTHENTICATED_RPCS],
    );
    check(missingRpcs.rowCount === 0,
      'Authenticated current-set RPC wrappers are not installed; transaction rolled back before configuration.');
    // Serializes a missing-config insert as well as a current config update.
    await client.query('SELECT public.department_current_set_lock($1::uuid)', [TENANT_ID]);
    const tenant = await client.query('SELECT id FROM public.tenant WHERE id = $1 FOR KEY SHARE', [TENANT_ID]);
    check(tenant.rowCount === 1, 'Destination tenant pin is unavailable inside the apply transaction.');
    const lockedForm = await client.query(
      'SELECT fields, require_authentication, is_active, survey_settings, access_policy FROM public.form WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [FORM_ID, TENANT_ID],
    );
    check(lockedForm.rowCount === 1, 'Pinned form disappeared before the guarded apply.');
    const actual = lockedForm.rows[0];
    check(actual.is_active === state.form.is_active
      && same(actual.fields, state.form.fields)
      && actual.require_authentication === state.form.require_authentication
      && same(actual.survey_settings, state.form.survey_settings)
      && same(actual.access_policy, state.form.access_policy),
    'Pinned form drifted after review; transaction rolled back.');
    const lockedConfig = await client.query(
      `SELECT config FROM public.${CURRENT_SET_CONFIG_TABLE} WHERE tenant_id = $1 AND form_id = $2 FOR UPDATE`,
      [TENANT_ID, FORM_ID],
    );
    check(lockedConfig.rowCount === (state.config.row ? 1 : 0)
      && (!state.config.row || same(lockedConfig.rows[0].config, state.config.row.config)),
    'Current-set config drifted after review; transaction rolled back.');
    const changesForm = !same(state.form.fields, state.candidate.fields)
      || state.form.require_authentication !== true;
    if (changesForm) {
      const updated = await client.query(
        'UPDATE public.form SET fields = $1::jsonb, require_authentication = true WHERE id = $2 AND tenant_id = $3 AND fields = $4::jsonb AND require_authentication IS NOT DISTINCT FROM $5 RETURNING id',
        [JSON.stringify(state.candidate.fields), FORM_ID, TENANT_ID, JSON.stringify(state.form.fields), state.form.require_authentication],
      );
      check(updated.rowCount === 1, 'Pinned form CAS lost a concurrent update; transaction rolled back.');
    }
    if (!state.config.row) {
      const inserted = await client.query(
        `INSERT INTO public.${CURRENT_SET_CONFIG_TABLE} (tenant_id, form_id, config) VALUES ($1, $2, $3::jsonb)`,
        [TENANT_ID, FORM_ID, JSON.stringify(state.desiredConfig)],
      );
      check(inserted.rowCount === 1, 'Current-set config insert did not complete; transaction rolled back.');
    }
    await client.query('COMMIT');
    return { backupPath, noOp: !changesForm && !!state.config.row };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

function reportFor(state) {
  return {
    review_version: 1,
    generated_at: new Date().toISOString(),
    tenantId: TENANT_ID,
    formId: FORM_ID,
    dryRun: !APPLY,
    configTable: CURRENT_SET_CONFIG_TABLE,
    schemaReady: state.config.schemaReady,
    rolloutReadiness: state.config.schemaReady
      ? 'staged: publish and verify the new API/client Department picker and authentication-reset changes before reviewed configuration apply'
      : `blocked: ${CURRENT_SET_CONFIG_TABLE} migration is not installed; application publish remains required before configuration apply`,
    preflightFingerprint: state.fingerprint,
    desiredConfigFingerprint: fingerprint(state.desiredConfig),
    rowCounts: state.counts,
    form: {
      wasAuthenticationRequired: state.form.require_authentication === true,
      authenticationWillBeRequired: true,
      authenticationChange: {
        approved: true,
        from: state.form.require_authentication === true,
        to: true,
        disclosure: 'This currently public form will require sign-in; only an assigned Department Survey respondent can use current-set operations.',
      },
      workforceMaximumRowsBefore: state.form.fields.find(field => field.id === FORM_FIELDS.workforceContainer)?.max_rows,
      workforceMaximumRowsAfter: 100,
      workforceDropdownOptionChanges: state.candidate.workforceDropdownChanges,
      workforceDropdownOptionsSynchronizedToCanonicalValues: true,
      equipmentMaximumRowsBefore: state.form.fields.find(field => field.id === FORM_FIELDS.equipmentContainer)?.max_rows,
      equipmentMaximumRowsAfter: 100,
      datesVerifiedYearOnly: true,
      formFieldIdsPreserved: true,
      repeatableContainerConstraints: state.containerConstraints,
      deliberateEmptyWorkforceAndEquipmentAllowed: true,
    },
    directWorkforce: {
      relationshipId: RELATIONSHIP_IDS.workforceDepartment,
      relationshipKey: 'workforce_survey_row_department',
      rowNameFieldRequired: false,
      importCapacity: state.workforceImportCapacity,
    },
    respondentAssignmentSuitability: {
      relationshipId: RELATIONSHIP_IDS.departmentRespondent,
      relationshipFieldKey: 'survey_respondent',
      ...state.counts.respondentAssignments,
      handling: 'Captured for reviewer action; rollout does not create, remove, or alter Department respondent assignments.',
    },
    departmentOrganisationSuitability: state.organisationSuitability,
    dropdownCanonicalCompatibility: state.formChoiceCompatibility,
    existingConfig: state.config.row ? 'already-configured' : 'absent',
    legacyGraphObservations: {
      equipmentWithoutExactlyOneDepartment: state.counts.equipmentWithoutExactlyOneDepartment,
      equipmentWithoutExactlyOneType: state.counts.equipmentWithoutExactlyOneType,
      equipmentWithMultipleModels: state.counts.equipmentWithMultipleModels,
      equipmentModelTypeMismatches: state.counts.equipmentModelTypeMismatches,
      handling: 'Reported only: rollout does not infer, repair, archive, or omit legacy records.',
    },
    rollout: {
      dataRecordsChanged: false,
      preparedWorkforceImportChanged: false,
      applyRequiresReviewedFingerprint: true,
      backupBeforeWrite: true,
      configWrittenOnlyWhenAbsentAndExact: true,
      guardedFormAndConfigTransaction: true,
      authenticatedWrappersRequiredBeforeConfig: true,
      stagedAfterApplicationDeployment: true,
      applicationPublishedAcknowledgementRequired: true,
      applicationPublishedAcknowledged: APPLICATION_PUBLISHED,
      applicationPublishScope: 'New API/client Department picker and authentication-reset changes must be published and verified before config activation.',
      preservesDraftAndPublicationState: true,
      automaticPublish: false,
      postcheckRequired: true,
    },
    outstanding: [
      'Schema-only migration installation is separate from form/configuration activation. Publish and verify the new API/client Department picker and authentication-reset changes before any --apply --application-published configuration command.',
      'The separately prepared BNMS workforce CSV import was not read, changed, or executed.',
      'Because this rollout changes related form/configuration metadata, repeat that import package’s required full destination re-audit and final approval review before any separate import execution.',
      'Run a signed-in live verification for a respondent flagged true for one Department and false/absent for another after code, migration, and this configuration rollout are deployed.',
    ],
  };
}

async function main() {
  const url = process.env.DEST_SUPABASE_URL;
  const key = process.env.DEST_SUPABASE_KEY;
  check(url && key, 'DEST_SUPABASE_URL and DEST_SUPABASE_KEY are required.');
  check(new URL(url).hostname === 'lvmzliemqnieeoruhkik.supabase.co',
    'Destination project pin mismatch; no alternate database is allowed.');
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const state = await preflight(db);
  let result = reportFor(state);
  if (APPLY) {
    const review = await readReview(reviewArgument);
    check(review.preflightFingerprint === state.fingerprint,
      'Destination state drifted since the reviewed dry run; no configuration was written.');
    const applied = await applyAtomically(state);
    const reloaded = await preflight(db);
    check(reloaded.form.require_authentication === true, 'Postcheck found authentication disabled.');
    check(same(reloaded.candidate.fields, reloaded.form.fields), 'Postcheck found an unexpected form field patch.');
    check(reloaded.config.row && validateCurrentSetConfig(reloaded.config.row.config, reloaded.candidate),
      'Postcheck found missing or drifted current-set config.');
    result = { ...reportFor(reloaded), dryRun: false, applied: !applied.noOp, noOp: applied.noOp, backupPath: path.relative(ROOT, applied.backupPath) };
  }
  if (reportArgument) {
    const destination = relativePath(reportArgument.slice('--report='.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(result, null, 2)}\n`);
    result = { ...result, reportPath: path.relative(ROOT, destination) };
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(`configure-department-current-set: ${error.message || error}`);
  process.exitCode = 1;
});