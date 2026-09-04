import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  ASSIGNMENT_COUNTS, COLUMN_COUNT, CORE_MAPPINGS, CUSTOM_MAPPINGS, EXPECTED_FILE_SHA256,
  HEADERS, IGNORED_COLUMNS, ROW_COUNT, TENANT_ID, auditHierarchy, auditMappings,
  auditNoReferenceEligibility, emailKey, makePlan, noReferenceRows, parseBritishDate,
  applyPlan, parseSourceBytes, runCompensated, sourceFileFromArgs, validateReturnedRows, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
function csvCell(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function sanitizedSourceBytes() {
  const rows = [HEADERS];
  for (let index = 0; index < ROW_COUNT; index += 1) {
    const row = Array(COLUMN_COUNT).fill('');
    row[0] = String(70000000 + index);
    row[1] = '1/3/2024';
    row[2] = index === 0 ? '24/08/2028' : '';
    row[3] = `member-${index}@example.test`;
    row[4] = 'Full Membership DD'; row[5] = 'Active'; row[6] = 'TRUE'; row[7] = 'Full';
    row[14] = `First${index}`; row[15] = `Last${index}`; row[16] = 'Dr';
    row[29] = 'Physician'; row[32] = index % 2 ? 'FALSE' : 'TRUE';
    row[34] = index === 13 ? '20 plus years' : '5 to 10 years';
    if (index < 101) row[26] = uuid(index % 48 + 1);
    else if (index < 184) row[27] = uuid(index % 40 + 101);
    else if (index < 326) row[28] = uuid(index % 83 + 201);
    rows.push(row);
  }
  return Buffer.from(rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), 'latin1');
}
const sanitizedBytes = sanitizedSourceBytes();
const source = parseSourceBytes(sanitizedBytes, { verifyFingerprint: false });
const optionValues = (mapping) => [...new Set(source.rows.map((row) => row.values[mapping.column]).filter(Boolean))]
  .map((value) => ({ label: value, value }));
const fields = CUSTOM_MAPPINGS.map((mapping) => ({
  id: mapping.id, tenant_id: TENANT_ID, name: mapping.name, label: mapping.label,
  field_type: mapping.type, entity_scope: 'member', is_active: true,
  options: mapping.type === 'dropdown' ? optionValues(mapping) : null,
}));
const relationshipDefinitions = [
  { id: 'parent-def', tenant_id: TENANT_ID, relationship_key: 'organisation', source_kind: 'custom_object', source_custom_object_id: 'department-object', target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one', is_required: true, status: 'active' },
  { id: 'member-def', tenant_id: TENANT_ID, relationship_key: 'members', source_kind: 'custom_object', source_custom_object_id: 'department-object', target_kind: 'member', target_custom_object_id: null, cardinality: 'many_to_many', is_required: false, status: 'active' },
];
const ids = (column) => [...new Set(source.rows.map((row) => row.values[column]).filter(Boolean))];
const groups = ids(26).map((id) => ({ id, tenant_id: TENANT_ID }));
const organizations = [...new Set([...ids(27), ...ids(28).map((id) => `parent-${id}`)])]
  .map((id) => ({ id, tenant_id: TENANT_ID, organization_group_id: groups[0].id }));
const departments = ids(28).map((id) => ({ id, tenant_id: TENANT_ID, custom_object_id: 'department-object', archived_at: null }));
const parentEdges = departments.map((row) => ({
  id: `edge-${row.id}`, tenant_id: TENANT_ID, relationship_definition_id: 'parent-def', source_record_id: row.id,
  target_record_id: `parent-${row.id}`, archived_at: null,
}));
const hierarchyState = { groups, organizations, departments, parentEdges, relationshipDefinitions };
const hierarchy = auditHierarchy(source, hierarchyState);
const mappings = auditMappings(fields, source);

test('pins the exact Windows-1252 CSV fingerprint, positional shape, and assignment counts', () => {
  assert.equal(EXPECTED_FILE_SHA256, 'a0898e80a14d75659688afe596c09d8e072882db85197f5b52c11a97c49f8844');
  assert.notEqual(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.deepEqual(source.counts, ASSIGNMENT_COUNTS);
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.deepEqual(IGNORED_COLUMNS.map((item) => item.column), [33, 37, 38, 39, 40]);
});

test('rejects fingerprint drift before accepting otherwise parseable data', () => {
  assert.throws(() => parseSourceBytes(sanitizedBytes), /fingerprint mismatch/);
  const changed = Buffer.from(sanitizedBytes);
  changed[changed.length - 3] ^= 1;
  assert.throws(() => parseSourceBytes(changed), /fingerprint mismatch/);
});

test('uses an explicit protected runtime path without relaxing fingerprint validation', () => {
  assert.equal(sourceFileFromArgs(['--file', '/secure/direct-debit.csv']), path.resolve('/secure/direct-debit.csv'));
  assert.throws(() => sourceFileFromArgs(['--file']), /requires a protected CSV path/);
});

test('validates real calendar dates and lowercases email deterministically', () => {
  assert.equal(parseBritishDate('29/2/2024'), '2024-02-29');
  assert.equal(parseBritishDate('1/3/2012'), '2012-03-01');
  assert.throws(() => parseBritishDate('29/2/2023'), /Invalid/);
  assert.throws(() => parseBritishDate('2024-02-29'), /dd\/mm\/yyyy/);
  assert.equal(emailKey('  Sample.Member@EXAMPLE.TEST '), 'sample.member@example.test');
});

test('the positional contract maps AF to job_title and explicitly ignores AH and AL-AO', () => {
  assert.deepEqual(CORE_MAPPINGS.find((item) => item.column === 31), { column: 31, destination: 'job_title' });
  assert.equal(CUSTOM_MAPPINGS.find((item) => item.column === 30).name, 'qualifications');
  assert.equal(CUSTOM_MAPPINGS.some((item) => item.column === 33), false);
  assert.equal(CUSTOM_MAPPINGS.length, 26);
});

test('requires exact active tenant-owned custom fields', () => {
  assert.equal(mappings.length, CUSTOM_MAPPINGS.length);
  assert.throws(() => auditMappings(fields.slice(1), source), /unambiguous/);
  assert.throws(() => auditMappings([...fields, { ...fields[0], id: 'another' }], source), /unambiguous/);
  assert.throws(() => auditMappings(fields.map((field, index) => index ? field : { ...field, tenant_id: 'other' }), source), /contract drifted/);
});

test('never canonicalizes unsupported dropdown values, including current 20 plus years', () => {
  const durationIndex = fields.findIndex((field) => field.name === 'duration-of-nm-experiece');
  assert.ok(source.rows.some((row) => row.values[34] === '20 plus years'));
  const productionOptions = fields.map((field, index) => index === durationIndex ? {
    ...field,
    options: field.options.map((option) => option.value === '20 plus years'
      ? { label: '20 years or more', value: '20 years or more' } : option),
  } : field);
  assert.throws(() => auditMappings(productionOptions, source), /Unsupported "Duration of NM experiece" value\(s\): 20 plus years.*never canonicalized/);
});

test('validates exact organisation and members relationship model and hierarchy parents', () => {
  assert.equal(hierarchy.groupIds.size, 48);
  assert.equal(hierarchy.organizationIds.size, 40);
  assert.equal(hierarchy.departmentIds.size, 83);
  assert.equal(hierarchy.departmentParents.size, 83);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, groups: groups.slice(1) }), /Row \d+: direct Organisation Group .*missing or outside BNMS/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, parentEdges: parentEdges.slice(1) }), /Row \d+: Department .*exactly one active/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, relationshipDefinitions: relationshipDefinitions.map((row) => row.id === 'member-def' ? { ...row, relationship_key: 'people' } : row) }), /exactly one "organisation" and one "members"/);
  const departmentRow = source.rows.find((row) => row.values[28]);
  const parentless = organizations.map((row) => row.id === `parent-${departmentRow.values[28]}` ? { ...row, organization_group_id: null } : row);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, organizations: parentless }), new RegExp(`Row ${departmentRow.sourceRow}: Department .*no valid BNMS Organisation Group`));
  const foreign = organizations.map((row) => row.id === `parent-${departmentRow.values[28]}` ? { ...row, organization_group_id: 'foreign-group' } : row);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, organizations: foreign }), /no valid BNMS Organisation Group/);
  const wrongObject = departments.map((row) => row.id === departmentRow.values[28] ? { ...row, custom_object_id: 'wrong-object' } : row);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, departments: wrongObject }), /belongs to the wrong custom object/);
  const foreignParent = organizations.map((row) => row.id === `parent-${departmentRow.values[28]}` ? { ...row, tenant_id: 'foreign' } : row);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, organizations: foreignParent }), new RegExp(`Row ${departmentRow.sourceRow}: Department .*exactly one active BNMS Organisation parent`));
});

test('allows an explicitly reported parentless Organisation-only assignment', () => {
  const row = source.rows.find((item) => item.values[27]);
  const parentless = organizations.map((item) => item.id === row.values[27]
    ? { ...item, organization_group_id: null } : item);
  const result = auditHierarchy({ ...source, rows: [row] }, { ...hierarchyState, organizations: parentless });
  assert.equal(result.organisationChains[0].approvedParentless, true);
  assert.equal(result.organisationChains[0].groupId, null);
});

test('direct group assignment plans organization_group_id and missing support fails clearly', () => {
  const row = source.rows.find((item) => item.values[26]);
  const member = { id: 'member-1', tenant_id: TENANT_ID, email: row.email, organization_group_id: null };
  const oneSource = { ...source, rows: [row] };
  const plan = makePlan(oneSource, { members: [member], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.equal(plan.items[0].patch.organization_group_id, row.values[26]);
  assert.equal(plan.items[0].action, 'update');
  const { organization_group_id: _missingColumn, ...unsupportedMember } = member;
  assert.throws(
    () => makePlan(oneSource, { members: [unsupportedMember], preferenceValues: [], memberEdges: [] }, mappings, hierarchy),
    /missing required member\.organization_group_id/,
  );
});

test('direct group assignment clears stale Organisation and archives stale Department edges', () => {
  const row = source.rows.find((item) => item.values[26]);
  const member = {
    id: 'member-group-replace', tenant_id: TENANT_ID, email: row.email,
    organization_id: 'stale-org', organization_group_id: 'stale-group',
  };
  const staleEdge = {
    id: 'stale-department-edge', tenant_id: TENANT_ID,
    relationship_definition_id: hierarchy.memberDefinition.id,
    source_record_id: 'stale-department', target_record_id: member.id,
    archived_at: null, archived_by: null,
  };
  const plan = makePlan(
    { ...source, rows: [row] },
    { members: [member], preferenceValues: [], memberEdges: [staleEdge] },
    mappings,
    hierarchy,
  );
  assert.equal(plan.items[0].patch.organization_group_id, row.values[26]);
  assert.equal(plan.items[0].patch.organization_id, null);
  assert.equal(plan.items[0].edgeAction, 'archive');
  assert.deepEqual(plan.items[0].conflictingEdges, [staleEdge]);
});

test('Organisation and Department assignments clear stale direct Group values', () => {
  for (const row of [
    source.rows.find((item) => item.values[27]),
    source.rows.find((item) => item.values[28]),
  ]) {
    const member = {
      id: `member-${row.sourceRow}`, tenant_id: TENANT_ID, email: row.email,
      organization_id: null, organization_group_id: 'stale-direct-group',
    };
    const plan = makePlan(
      { ...source, rows: [row] },
      { members: [member], preferenceValues: [], memberEdges: [] },
      mappings,
      hierarchy,
    );
    assert.equal(plan.items[0].patch.organization_group_id, null);
  }
});

test('plans by normalized email, only supplied core values, and never clears blanks', () => {
  const row = source.rows.find((item) => !item.values[2] && !item.values[17] && !item.values[26] && !item.values[27] && !item.values[28]);
  const member = {
    id: 'member-1', tenant_id: TENANT_ID, email: row.email.toUpperCase(),
    first_name: row.values[14], last_name: row.values[15], landline: 'preserve landline',
    mobile: 'preserve mobile', job_title: 'preserve job title', created_on: parseBritishDate(row.values[1]),
  };
  const plan = makePlan({ ...source, rows: [row] }, { members: [member], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.equal(plan.items[0].member, member);
  assert.equal('organization_id' in plan.items[0].patch, false);
  assert.equal('organization_group_id' in plan.items[0].patch, false);
  if (!row.values[24]) assert.equal('landline' in plan.items[0].patch, false);
  if (!row.values[25]) assert.equal('mobile' in plan.items[0].patch, false);
  if (!row.values[31]) assert.equal('job_title' in plan.items[0].patch, false);
  assert.equal(plan.items[0].preferences.some((item) => item.mapping.column === 2), false);
  assert.equal(plan.items[0].preferences.some((item) => item.mapping.column === 17), false);
});

test('reports all 30 no-reference rows and only permits new unassigned Members after nullability audit', () => {
  const rows = noReferenceRows(source);
  assert.equal(rows.length, ASSIGNMENT_COUNTS.none);
  assert.ok(rows.every((row) => Number.isInteger(row.sourceRow) && row.email.includes('@')));
  const sourceRow = source.rows.find((row) => row.sourceRow === rows[0].sourceRow);
  const plan = makePlan({ ...source, rows: [sourceRow] }, { members: [], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.throws(() => auditNoReferenceEligibility(source, { memberAssignmentNullability: null }, plan), /cannot be inserted until/);
  assert.doesNotThrow(() => auditNoReferenceEligibility(source, {
    memberAssignmentNullability: { organization_id: true, organization_group_id: true },
  }, plan));
  const assigned = { id: 'existing', tenant_id: TENANT_ID, email: sourceRow.email, organization_id: 'keep-org', organization_group_id: 'keep-group' };
  const existingPlan = makePlan({ ...source, rows: [sourceRow] }, { members: [assigned], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.doesNotThrow(() => auditNoReferenceEligibility(source, { memberAssignmentNullability: null }, existingPlan));
  assert.equal('organization_id' in existingPlan.items[0].patch, false);
  assert.equal('organization_group_id' in existingPlan.items[0].patch, false);
});

test('ignores unrelated tenant Members when matching the exact source email set', () => {
  const row = source.rows[0];
  const relevant = { id: 'relevant', tenant_id: TENANT_ID, email: row.email, organization_group_id: null };
  const unrelated = { id: 'unrelated', tenant_id: TENANT_ID, email: 'unrelated@example.test', organization_id: 'keep' };
  const plan = makePlan({ ...source, rows: [row] }, { members: [relevant, unrelated], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.equal(plan.items[0].member.id, relevant.id);
});

test('department assignment derives its parent Organisation and exact members edge', () => {
  const row = source.rows.find((item) => item.values[28]);
  const member = { id: 'member-1', tenant_id: TENANT_ID, email: row.email, organization_id: null };
  const expectedParent = hierarchy.departmentParents.get(row.values[28]);
  let plan = makePlan({ ...source, rows: [row] }, { members: [member], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.equal(plan.items[0].patch.organization_id, expectedParent);
  assert.equal(plan.items[0].edgeAction, 'insert');
  const memberEdges = [{ id: 'edge', relationship_definition_id: 'member-def', source_record_id: row.values[28], target_record_id: member.id, archived_at: null }];
  plan = makePlan({ ...source, rows: [row] }, { members: [{ ...member, organization_id: expectedParent }], preferenceValues: [], memberEdges }, mappings, hierarchy);
  assert.equal(plan.items[0].edgeAction, 'unchanged');
});

function exactEdgeTriggerDb(state, { failLaterInsert = false } = {}) {
  class Query {
    constructor(table) { this.table = table; this.payload = null; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    eq() { return this; }
    select() { return this; }
    single() { return this.execute(true); }
    then(resolve, reject) { return this.execute(false).then(resolve, reject); }
    async execute(single) {
      if (this.table === 'member' && this.operation === 'update') {
        state.member = { ...state.member, ...this.payload };
        if (this.payload.organization_id === 'correct-org') {
          state.edge.archived_at = 'trigger-archived';
          state.edge.archived_by = 'system:member_organization_change';
        }
        return { data: single ? { ...state.member } : [{ id: state.member.id }], error: null };
      }
      if (this.table === 'member' && this.operation === 'insert' && failLaterInsert) {
        return { data: null, error: { message: 'simulated later failure' } };
      }
      if (this.table === 'custom_object_relationship' && !this.operation) {
        return { data: [{ ...state.edge }], error: null };
      }
      if (this.table === 'custom_object_relationship' && this.operation === 'update') {
        state.edge = { ...state.edge, ...this.payload };
        return { data: [{ ...state.edge }], error: null };
      }
      throw new Error(`Unexpected mock query: ${this.table} ${this.operation}`);
    }
  }
  return { from: (table) => new Query(table) };
}

function exactEdgeCorrectionItem(state) {
  return {
    row: { email: state.member.email },
    member: { ...state.member },
    action: 'update',
    patch: { organization_id: 'correct-org' },
    preferences: [],
    edgeAction: 'unchanged',
    conflictingEdges: [],
    exactEdges: [{ ...state.edge }],
    activeDepartmentEdges: [{ ...state.edge }],
    departmentId: state.edge.source_record_id,
  };
}

test('Organisation correction keeps the exact desired Department edge active', async () => {
  const state = {
    member: { id: 'member-exact', tenant_id: TENANT_ID, email: 'exact-success@example.test', organization_id: 'wrong-org' },
    edge: {
      id: 'exact-edge', relationship_definition_id: 'member-def', source_record_id: 'desired-department',
      target_record_id: 'member-exact', archived_at: null, archived_by: null,
    },
  };
  const result = await applyPlan(
    exactEdgeTriggerDb(state),
    { items: [exactEdgeCorrectionItem(state)] },
    { memberDefinition: { id: 'member-def' } },
  );
  assert.equal(result.memberWrites, 1);
  assert.equal(result.edgeWrites, 1);
  assert.equal(state.member.organization_id, 'correct-org');
  assert.equal(state.edge.archived_at, null);
  assert.equal(state.edge.archived_by, null);
});

test('later failure restores an exact Department edge archived during Organisation correction', async () => {
  const state = {
    member: { id: 'member-exact-rollback', tenant_id: TENANT_ID, email: 'exact-rollback@example.test', organization_id: 'wrong-org' },
    edge: {
      id: 'exact-edge-rollback', relationship_definition_id: 'member-def', source_record_id: 'desired-department',
      target_record_id: 'member-exact-rollback', archived_at: null, archived_by: null,
    },
  };
  const failingItem = {
    row: { email: 'later-exact@example.test' }, member: null, action: 'insert',
    patch: { email: 'later-exact@example.test' }, preferences: [], edgeAction: 'none',
    conflictingEdges: [], exactEdges: [], activeDepartmentEdges: [], departmentId: null,
  };
  await assert.rejects(
    () => applyPlan(
      exactEdgeTriggerDb(state, { failLaterInsert: true }),
      { items: [exactEdgeCorrectionItem(state), failingItem] },
      { memberDefinition: { id: 'member-def' } },
    ),
    /simulated later failure/,
  );
  assert.equal(state.member.organization_id, 'wrong-org');
  assert.equal(state.edge.archived_at, null);
  assert.equal(state.edge.archived_by, null);
});

test('plans an explicit Department edge replacement when the pinned source differs', () => {
  const row = source.rows.find((item) => item.values[28]);
  const member = { id: 'member-conflict', tenant_id: TENANT_ID, email: row.email, organization_id: null, organization_group_id: null };
  const existing = {
    id: 'old-edge', tenant_id: TENANT_ID, relationship_definition_id: hierarchy.memberDefinition.id,
    source_record_id: '00000000-0000-4000-8000-000000008888', target_record_id: member.id, archived_at: null,
  };
  const plan = makePlan(
    { ...source, rows: [row] },
    { members: [member], preferenceValues: [], memberEdges: [existing] },
    mappings,
    hierarchy,
  );
  assert.equal(plan.items[0].edgeAction, 'replace');
  assert.deepEqual(plan.items[0].conflictingEdges, [existing]);
  assert.deepEqual(plan.items[0].departmentIds, [row.values[28]]);
});

test('Department replacement reconciles many existing assignments and rejects duplicate or foreign edges', () => {
  const row = source.rows.find((item) => item.values[28]);
  const member = {
    id: 'member-many', tenant_id: TENANT_ID, email: row.email,
    organization_id: hierarchy.departmentParents.get(row.values[28]), organization_group_id: null,
  };
  const desired = {
    id: 'desired', tenant_id: TENANT_ID, relationship_definition_id: 'member-def',
    source_record_id: row.values[28], target_record_id: member.id, archived_at: null,
  };
  const extras = ['extra-a', 'extra-b'].map((id) => ({
    id, tenant_id: TENANT_ID, relationship_definition_id: 'member-def',
    source_record_id: id, target_record_id: member.id, archived_at: null,
  }));
  const plan = makePlan(
    { ...source, rows: [row] },
    { members: [member], preferenceValues: [], memberEdges: [desired, ...extras] },
    mappings,
    hierarchy,
  );
  assert.equal(plan.items[0].edgeAction, 'archive');
  assert.deepEqual(plan.items[0].conflictingEdges, extras);
  assert.deepEqual(plan.items[0].exactEdges, [desired]);

  assert.throws(() => makePlan(
    { ...source, rows: [row] },
    { members: [member], preferenceValues: [], memberEdges: [desired, { ...desired, id: 'duplicate' }] },
    mappings,
    hierarchy,
  ), /duplicate active Department member edges/);
  assert.throws(() => makePlan(
    { ...source, rows: [row] },
    { members: [member], preferenceValues: [], memberEdges: [{ ...desired, tenant_id: 'foreign' }] },
    mappings,
    hierarchy,
  ), /outside BNMS/);
});

test('mixed insert/update/unchanged preferences replay to exactly zero writes', () => {
  const rows = source.rows.slice(0, 3);
  const members = rows.map((row, index) => ({
    id: `member-${index}`, tenant_id: TENANT_ID, email: row.email,
    created_on: row.values[1] ? parseBritishDate(row.values[1]) : null,
    first_name: row.values[14], last_name: row.values[15], landline: row.values[24] || null,
    mobile: row.values[25] || null, job_title: row.values[31] || null,
    organization_group_id: row.values[26] || null,
    organization_id: row.values[27] || (row.values[28] ? hierarchy.departmentParents.get(row.values[28]) : null),
  }));
  const allValues = rows.flatMap((row, rowIndex) => mappings.flatMap((mapping) => {
    if (!row.values[mapping.column]) return [];
    const value = mapping.transform === 'boolean' ? row.values[mapping.column] === 'TRUE'
      : mapping.transform === 'date' ? parseBritishDate(row.values[mapping.column]) : row.values[mapping.column];
    return [{ id: `${rowIndex}-${mapping.id}`, member_id: members[rowIndex].id, field_id: mapping.id, value }];
  }));
  const memberEdges = rows.flatMap((row, index) => row.values[28] ? [{
    id: `edge-${index}`, relationship_definition_id: 'member-def', source_record_id: row.values[28],
    target_record_id: members[index].id, archived_at: null,
  }] : []);
  const plan = makePlan({ ...source, rows }, { members, preferenceValues: allValues, memberEdges }, mappings, hierarchy);
  assert.ok(plan.items.every((item) => item.action === 'unchanged'));
  assert.ok(plan.items.flatMap((item) => item.preferences).every((item) => item.action === 'unchanged'));
  assert.ok(plan.items.every((item) => item.edgeAction !== 'insert'));
  assert.throws(() => makePlan({ ...source, rows }, { members, preferenceValues: [...allValues, { ...allValues[0], id: 'duplicate' }], memberEdges }, mappings, hierarchy), /Duplicate preference values/);
});

test('fails closed on partial and unexpected checked write results', () => {
  const expected = [
    { member_id: 'one', field_id: 'field', value: 'a' },
    { member_id: 'two', field_id: 'field', value: 'b' },
  ];
  assert.throws(() => validateReturnedRows(expected.slice(1), expected, ['member_id', 'field_id']), /1\/2/);
  assert.throws(() => validateReturnedRows([{ ...expected[0], value: 'wrong' }, expected[1]], expected, ['member_id', 'field_id']), /unexpected/);
  assert.doesNotThrow(() => validateReturnedRows(expected, expected, ['member_id', 'field_id']));
});

test('compensation helper restores completed operations after a deterministic mid-run failure', async () => {
  const state = [];
  await assert.rejects(() => runCompensated([
    { apply: async () => state.push('member'), rollback: async () => { assert.equal(state.pop(), 'member'); } },
    { apply: async () => state.push('pref'), rollback: async () => { assert.equal(state.pop(), 'pref'); } },
    { apply: async () => { throw new Error('simulated edge failure'); }, rollback: async () => {} },
  ]), /simulated edge failure/);
  assert.deepEqual(state, []);
});

test('post-write verification failure compensates every completed write', async () => {
  const restored = [];
  const journal = [
    { label: 'first', rollback: async () => restored.push('first') },
    { label: 'second', rollback: async () => restored.push('second') },
  ];
  await assert.rejects(
    verifyOrCompensate(journal, async () => { throw new Error('replay mismatch'); }),
    /replay mismatch/,
  );
  assert.deepEqual(restored, ['second', 'first']);
});

test('rollback restores a Department edge auto-archived by the Organisation update trigger', async () => {
  const state = {
    member: { id: 'member-1', tenant_id: TENANT_ID, email: 'trigger-test@example.test', organization_id: 'old-org' },
    edge: { id: 'old-edge', archived_at: null, archived_by: null },
  };
  class Query {
    constructor(table) { this.table = table; this.payload = null; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    eq() { return this; }
    in() { return this; }
    is() { return this; }
    select() { return this; }
    single() { return this.execute(true); }
    then(resolve, reject) { return this.execute(false).then(resolve, reject); }
    async execute(single) {
      if (this.table === 'member' && this.operation === 'update') {
        state.member = { ...state.member, ...this.payload };
        if (this.payload.organization_id === 'new-org') {
          state.edge.archived_at = 'trigger-archived';
          state.edge.archived_by = 'system:member_organization_change';
        }
        return { data: single ? { ...state.member } : [{ id: state.member.id }], error: null };
      }
      if (this.table === 'custom_object_relationship' && this.operation === 'update') {
        if (this.payload.archived_at === null) {
          state.edge = { ...state.edge, ...this.payload };
          return { data: [{ ...state.edge }], error: null };
        }
        if (state.edge.archived_at == null) {
          state.edge = { ...state.edge, ...this.payload };
          return { data: [{ ...state.edge }], error: null };
        }
        return { data: [], error: null };
      }
      if (this.table === 'custom_object_relationship' && this.operation === 'insert') {
        return { data: null, error: { message: 'simulated edge insert failure' } };
      }
      if (this.table === 'custom_object_relationship' && !this.operation) {
        return { data: state.edge.archived_at == null ? [{ id: state.edge.id }] : [], error: null };
      }
      throw new Error(`Unexpected mock query: ${this.table} ${this.operation}`);
    }
  }
  const db = { from: (table) => new Query(table) };
  const item = {
    row: { email: state.member.email },
    member: { ...state.member },
    action: 'update',
    patch: { organization_id: 'new-org' },
    preferences: [],
    edgeAction: 'replace',
    conflictingEdges: [{ ...state.edge }],
    departmentId: 'new-department',
  };
  await assert.rejects(
    () => applyPlan(db, { items: [item] }, { memberDefinition: { id: 'member-def' } }),
    /simulated edge insert failure/,
  );
  assert.equal(state.member.organization_id, 'old-org');
  assert.equal(state.edge.archived_at, null);
  assert.equal(state.edge.archived_by, null);
});

test('direct Group reassignment rollback restores stale Organisation and Department state', async () => {
  const state = {
    member: {
      id: 'member-direct-group', tenant_id: TENANT_ID, email: 'direct-group@example.test',
      organization_id: 'old-org', organization_group_id: 'old-group',
    },
    edge: { id: 'old-direct-group-edge', archived_at: null, archived_by: null },
  };
  class Query {
    constructor(table) { this.table = table; this.payload = null; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    eq() { return this; }
    in() { return this; }
    is() { return this; }
    select() { return this; }
    single() { return this.execute(true); }
    then(resolve, reject) { return this.execute(false).then(resolve, reject); }
    async execute(single) {
      if (this.table === 'member' && this.operation === 'update') {
        state.member = { ...state.member, ...this.payload };
        if (this.payload.organization_id === null) {
          state.edge.archived_at = 'trigger-archived';
          state.edge.archived_by = 'system:member_organization_change';
        }
        return { data: single ? { ...state.member } : [{ id: state.member.id }], error: null };
      }
      if (this.table === 'member' && this.operation === 'insert') {
        return { data: null, error: { message: 'simulated later member failure' } };
      }
      if (this.table === 'custom_object_relationship' && this.operation === 'update') {
        if (this.payload.archived_at === null) {
          state.edge = { ...state.edge, ...this.payload };
          return { data: [{ ...state.edge }], error: null };
        }
        return { data: [], error: null };
      }
      if (this.table === 'custom_object_relationship' && !this.operation) {
        return { data: state.edge.archived_at == null ? [{ id: state.edge.id }] : [], error: null };
      }
      throw new Error(`Unexpected mock query: ${this.table} ${this.operation}`);
    }
  }
  const db = { from: (table) => new Query(table) };
  const groupItem = {
    row: { email: state.member.email },
    member: { ...state.member },
    action: 'update',
    patch: { organization_id: null, organization_group_id: 'new-group' },
    preferences: [],
    edgeAction: 'archive',
    conflictingEdges: [{ ...state.edge }],
    departmentId: null,
  };
  const failingItem = {
    row: { email: 'later@example.test' },
    member: null,
    action: 'insert',
    patch: { email: 'later@example.test' },
    preferences: [],
    edgeAction: 'none',
    conflictingEdges: [],
    departmentId: null,
  };
  await assert.rejects(
    () => applyPlan(db, { items: [groupItem, failingItem] }, { memberDefinition: { id: 'member-def' } }),
    /simulated later member failure/,
  );
  assert.equal(state.member.organization_id, 'old-org');
  assert.equal(state.member.organization_group_id, 'old-group');
  assert.equal(state.edge.archived_at, null);
  assert.equal(state.edge.archived_by, null);
});

test('a silent Department archive no-op fails closed and compensates', async () => {
  const state = {
    member: {
      id: 'member-archive-noop', tenant_id: TENANT_ID, email: 'archive-noop@example.test',
      organization_id: null, organization_group_id: 'old-group',
    },
    edge: { id: 'active-edge', archived_at: null, archived_by: null },
  };
  class Query {
    constructor(table) { this.table = table; this.payload = null; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    eq() { return this; }
    in() { return this; }
    is() { return this; }
    select() { return this; }
    single() { return this.execute(true); }
    then(resolve, reject) { return this.execute(false).then(resolve, reject); }
    async execute(single) {
      if (this.table === 'member' && this.operation === 'update') {
        state.member = { ...state.member, ...this.payload };
        return { data: single ? { ...state.member } : [{ id: state.member.id }], error: null };
      }
      if (this.table === 'custom_object_relationship' && this.operation === 'update') {
        if (this.payload.archived_at === null) {
          state.edge = { ...state.edge, ...this.payload };
          return { data: [{ ...state.edge }], error: null };
        }
        return { data: [], error: null }; // Simulate a filtered/no-op archive.
      }
      if (this.table === 'custom_object_relationship' && !this.operation) {
        return { data: [{ id: state.edge.id }], error: null };
      }
      throw new Error(`Unexpected mock query: ${this.table} ${this.operation}`);
    }
  }
  const db = { from: (table) => new Query(table) };
  const item = {
    row: { email: state.member.email },
    member: { ...state.member },
    action: 'update',
    patch: { organization_group_id: 'new-group' },
    preferences: [],
    edgeAction: 'archive',
    conflictingEdges: [{ ...state.edge }],
    departmentId: null,
  };
  await assert.rejects(
    () => applyPlan(db, { items: [item] }, { memberDefinition: { id: 'member-def' } }),
    /Could not archive 1 prior Department member edge/,
  );
  assert.equal(state.member.organization_group_id, 'old-group');
  assert.equal(state.edge.archived_at, null);
});