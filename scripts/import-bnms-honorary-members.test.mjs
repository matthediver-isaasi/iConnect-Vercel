import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import {
  ASSIGNMENT_COUNTS, COLUMN_COUNT, CORE_MAPPINGS, CUSTOM_MAPPINGS,
  EXPECTED_FILE_SHA256, FILE, HEADERS, ROW_COUNT, auditHierarchy, auditMappings,
  makePlan, noReferenceRows, parseSourceBytes, protectedRelationshipRows, readSource,
} from './import-bnms-honorary-members.mjs';
import {
  TENANT_ID, applyPlan, parseBritishDate, verifyOrCompensate,
} from './import-bnms-direct-debit-members.mjs';

function csvBytes(rows) {
  const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return Buffer.from(rows.map((row) => row.map(cell).join(',')).join('\r\n'));
}

const syntheticRows = Array.from({ length: ROW_COUNT }, (_, index) => {
  const row = Array(COLUMN_COUNT).fill('');
  row[0] = `TEST-HONORARY-${index + 1}`;
  row[1] = '01/01/2020';
  row[3] = 'Honorary Membership';
  row[4] = 'Honorary';
  row[5] = 'Active';
  row[6] = 'Fixture';
  row[7] = `Member ${index + 1}`;
  row[8] = 'Mx';
  row[9] = `honorary-${index + 1}@example.test`;
  row[16] = 'United Kingdom';
  row[21] = `Occupation ${index % 2 + 1}`;
  row[22] = 'Synthetic test qualification';
  if (index === 0 || index === ASSIGNMENT_COUNTS.department + 1) {
    row[19] = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  } else if (index >= 1 && index <= ASSIGNMENT_COUNTS.department) {
    row[20] = `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  }
  return row;
});
const source = parseSourceBytes(csvBytes([HEADERS, ...syntheticRows]), { verifyFingerprint: false });
const fields = CUSTOM_MAPPINGS.map((mapping) => ({
  id: mapping.id, tenant_id: TENANT_ID, name: mapping.name, label: mapping.label,
  field_type: mapping.type, entity_scope: 'member', is_active: true,
  options: mapping.type === 'dropdown'
    ? [...new Set(source.rows.map((row) => row.values[mapping.column]).filter(Boolean))].map((value) => ({ label: value, value }))
    : null,
}));
const definitions = [
  { id: 'parent-def', tenant_id: TENANT_ID, relationship_key: 'organisation', source_kind: 'custom_object', source_custom_object_id: 'department-object', target_kind: 'organization', cardinality: 'many_to_one', is_required: true, status: 'active' },
  { id: 'member-def', tenant_id: TENANT_ID, relationship_key: 'members', source_kind: 'custom_object', source_custom_object_id: 'department-object', target_kind: 'member', cardinality: 'one_to_many', is_required: false, status: 'active' },
];
const organizationIds = [...new Set(source.rows.map((row) => row.values[19]).filter(Boolean))];
const departmentIds = [...new Set(source.rows.map((row) => row.values[20]).filter(Boolean))];
const groups = [{ id: 'group', tenant_id: TENANT_ID }];
const organizations = [
  ...organizationIds.map((id) => ({ id, tenant_id: TENANT_ID, organization_group_id: 'group' })),
  ...departmentIds.map((id) => ({ id: `parent-${id}`, tenant_id: TENANT_ID, organization_group_id: 'group' })),
];
const departments = departmentIds.map((id) => ({ id, tenant_id: TENANT_ID, custom_object_id: 'department-object', archived_at: null }));
const parentEdges = departments.map((item) => ({
  id: `edge-${item.id}`, tenant_id: TENANT_ID, relationship_definition_id: 'parent-def',
  source_record_id: item.id, target_record_id: `parent-${item.id}`, archived_at: null,
}));
const hierarchyState = { groups, organizations, departments, parentEdges, relationshipDefinitions: definitions };
const mappings = auditMappings(fields, source);
const hierarchy = auditHierarchy(source, hierarchyState);

function mutateSource(mutator) {
  const rows = [HEADERS, ...source.rows.map((row) => [...row.values])];
  mutator(rows);
  return parseSourceBytes(csvBytes(rows), { verifyFingerprint: false });
}

test('synthetic fixture preserves the 21-row/23-column contract, identities, constants and assignments', () => {
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.deepEqual(source.counts, ASSIGNMENT_COUNTS);
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.legacyId)).size, ROW_COUNT);
  assert.ok(source.rows.every((row) => row.values[2] === ''));
  assert.deepEqual([...new Set(source.rows.map((row) => row.values[3]))], ['Honorary Membership']);
});

test('pins the exact protected source fingerprint when the local import file is available', {
  skip: !existsSync(FILE),
}, () => {
  assert.equal(readSource().fingerprint, EXPECTED_FILE_SHA256);
});

test('rejects fingerprint drift and malformed source identities, dates and UUID exclusivity', () => {
  const changed = Buffer.from(source.rows[0].email);
  assert.throws(() => parseSourceBytes(changed), /fingerprint mismatch/);
  assert.throws(() => mutateSource((rows) => { rows[2][9] = rows[1][9].toUpperCase(); }), /Duplicate normalized Email/);
  assert.throws(() => mutateSource((rows) => { rows[2][0] = rows[1][0]; }), /Duplicate YM Web Site Member ID/);
  assert.throws(() => mutateSource((rows) => { rows[1][1] = '31/2/2007'; }), /Invalid/);
  assert.throws(() => mutateSource((rows) => { rows[1][19] = 'bad'; }), /invalid UUID/);
  assert.throws(() => mutateSource((rows) => { rows[2][19] = organizationIds[0]; }), /both Organisation and Department/);
  assert.throws(() => mutateSource((rows) => { rows[1][2] = '1/1/2030'; }), /unexpectedly supplies/);
});

test('explicit mappings cover every non-relationship column and require exact active fields/options', () => {
  assert.deepEqual([...new Set([...CORE_MAPPINGS, ...CUSTOM_MAPPINGS].map((item) => item.column))].sort((a, b) => a - b),
    [...Array(19).keys(), 21, 22]);
  assert.equal(mappings.length, 15);
  assert.throws(() => auditMappings(fields.slice(1), source), /unambiguous/);
  assert.throws(() => auditMappings([...fields, { ...fields[0], id: 'duplicate' }], source), /unambiguous/);
  assert.throws(() => auditMappings(fields.map((field, i) => i ? field : { ...field, entity_scope: 'organization' }), source), /contract drifted/);
  const membership = fields.findIndex((field) => field.name === 'ym_membership_type');
  assert.throws(() => auditMappings(fields.map((field, i) => i === membership ? { ...field, options: [] } : field), source), /Unsupported/);
});

test('requires exact tenant hierarchy and complete Organisation -> Group chains', () => {
  assert.equal(hierarchy.organizationChains.length, 2);
  assert.equal(hierarchy.departmentChains.length, 5);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, organizations: organizations.slice(1) }), /Organisation .*missing or outside BNMS/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, parentEdges: parentEdges.slice(1) }), /exactly one active/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, groups: [] }), /no valid BNMS Organisation Group/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, departments: departments.map((item, i) => i ? item : { ...item, tenant_id: 'foreign' }) }), /outside BNMS/);
  assert.throws(() => auditHierarchy(source, { ...hierarchyState, relationshipDefinitions: definitions.slice(1) }), /requires exactly one compatible/);
});

test('plans mixed creates/updates/unchanged, preserves blanks, and reports 14 unassigned rows', () => {
  const rows = source.rows.slice(0, 3);
  const exactCore = (row, id) => Object.fromEntries([
    ['id', id], ['tenant_id', TENANT_ID], ['email', row.email],
    ...CORE_MAPPINGS.filter((mapping) => mapping.destination !== 'email' && row.values[mapping.column])
      .map((mapping) => [mapping.destination, mapping.transform === 'date'
        ? parseBritishDate(row.values[mapping.column]) : row.values[mapping.column]]),
  ]);
  const members = [
    { id: 'one', tenant_id: TENANT_ID, email: rows[0].email.toUpperCase(), organization_id: null },
    { ...exactCore(rows[1], 'two'), organization_id: hierarchy.departmentParents.get(rows[1].values[20]) },
  ];
  const values = mappings.flatMap((mapping) => rows[1].values[mapping.column] ? [{
    id: mapping.id, member_id: 'two', field_id: mapping.id, value: rows[1].values[mapping.column],
  }] : []);
  const edges = rows[1].values[20] ? [{ id: 'edge', relationship_definition_id: 'member-def', source_record_id: rows[1].values[20], target_record_id: 'two', archived_at: null }] : [];
  const plan = makePlan({ ...source, rows }, { members, preferenceValues: values, memberEdges: edges }, mappings, hierarchy);
  assert.equal(plan.items[0].action, 'update');
  assert.equal(plan.items[1].action, 'unchanged');
  assert.equal(plan.items[2].action, 'insert');
  assert.equal(plan.items[0].preferences.some((pref) => pref.mapping.column === 2), false);
  assert.equal(noReferenceRows(source).length, 14);
});

test('plans exact Department links and replay proposes zero writes', () => {
  const row = source.rows.find((item) => item.values[20]);
  const organizationId = hierarchy.departmentParents.get(row.values[20]);
  const member = {
    id: 'member', tenant_id: TENANT_ID, email: row.email, created_on: parseBritishDate(row.values[1]),
    first_name: row.values[6], last_name: row.values[7], landline: row.values[17] || null,
    mobile: row.values[18] || null, organization_id: organizationId,
  };
  const values = mappings.flatMap((mapping) => row.values[mapping.column] ? [{
    id: mapping.id, member_id: member.id, field_id: mapping.id, value: row.values[mapping.column],
  }] : []);
  const memberEdges = [{ id: 'member-edge', relationship_definition_id: 'member-def', source_record_id: row.values[20], target_record_id: member.id, archived_at: null }];
  const replay = makePlan({ ...source, rows: [row] }, { members: [member], preferenceValues: values, memberEdges }, mappings, hierarchy);
  assert.equal(replay.items[0].action, 'unchanged');
  assert.ok(replay.items[0].preferences.every((item) => item.action === 'unchanged'));
  assert.equal(replay.items[0].edgeAction, 'unchanged');
  assert.throws(() => makePlan({ ...source, rows: [row] }, { members: [member], preferenceValues: [...values, { ...values[0], id: 'dup' }], memberEdges }, mappings, hierarchy), /Duplicate preference values/);
});

test('new unassigned members do not receive an invented relationship', () => {
  const row = source.rows.find((item) => !item.values[19] && !item.values[20]);
  const plan = makePlan({ ...source, rows: [row] }, { members: [], preferenceValues: [], memberEdges: [] }, mappings, hierarchy);
  assert.equal(plan.items[0].action, 'insert');
  assert.equal('organization_id' in plan.items[0].patch, false);
  assert.equal(plan.items[0].edgeAction, 'none');
});

test('preservation keeps all unrelated relationship types and no-reference Department edges', () => {
  const protectedIds = new Set(['assigned', 'unassigned']);
  const managedIds = new Set(['assigned']);
  const edges = [
    { id: 'managed-assigned', target_record_id: 'assigned', relationship_definition_id: 'member-def' },
    { id: 'other-assigned', target_record_id: 'assigned', relationship_definition_id: 'other-def' },
    { id: 'managed-unassigned', target_record_id: 'unassigned', relationship_definition_id: 'member-def' },
    { id: 'outside', target_record_id: 'outside', relationship_definition_id: 'other-def' },
  ];
  assert.deepEqual(
    protectedRelationshipRows(edges, protectedIds, managedIds, 'member-def').map((row) => row.id),
    ['other-assigned', 'managed-unassigned'],
  );
});

test('partial preference failure compensates an inserted Member, and verify failure reverses the journal', async () => {
  const calls = [];
  class Query {
    constructor(table) { this.table = table; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    upsert(payload) { this.operation = 'upsert'; this.payload = payload; return this; }
    delete() { this.operation = 'delete'; return this; }
    eq() { return this; }
    select() { return this; }
    single() { return this.execute(true); }
    then(resolve, reject) { return this.execute(false).then(resolve, reject); }
    async execute(single) {
      calls.push(`${this.table}:${this.operation}`);
      if (this.table === 'member' && this.operation === 'insert') {
        return { data: { id: 'created', tenant_id: TENANT_ID, email: 'created@example.test' }, error: null };
      }
      if (this.table === 'member_preference_value' && this.operation === 'upsert') {
        return { data: null, error: { message: 'simulated preference failure' } };
      }
      if (this.table === 'member' && this.operation === 'delete') {
        return { data: [{ id: 'created' }], error: null };
      }
      throw new Error(`Unexpected ${this.table}:${this.operation}:${single}`);
    }
  }
  const db = { from: (table) => new Query(table) };
  const plan = { items: [{
    row: { email: 'created@example.test' }, member: null, action: 'insert',
    patch: { email: 'created@example.test' },
    preferences: [{ action: 'insert', desired: 'Honorary', existing: null, mapping: { id: 'field' } }],
    edgeAction: 'none', conflictingEdges: [], exactEdges: [], activeDepartmentEdges: [], departmentId: null,
  }] };
  await assert.rejects(() => applyPlan(db, plan, { memberDefinition: { id: 'member-def' } }), /simulated preference failure/);
  assert.deepEqual(calls, [
    'member:insert', 'member_preference_value:upsert',
    'member_preference_value:delete', 'member:delete',
  ]);

  const restored = [];
  await assert.rejects(() => verifyOrCompensate([
    { label: 'member', rollback: async () => restored.push('member') },
    { label: 'preference', rollback: async () => restored.push('preference') },
  ], async () => { throw new Error('verification failed'); }), /verification failed/);
  assert.deepEqual(restored, ['preference', 'member']);
});