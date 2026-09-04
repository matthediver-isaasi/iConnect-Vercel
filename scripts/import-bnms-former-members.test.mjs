import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  COLUMN_COUNT, EXPECTED_FILE_SHA256, FILE, HEADERS, IMPORT_ROW_COUNT, ROW_COUNT,
  REVIEWED_EMAILLESS_LEGACY_IDS, REVIEWED_SCIENTIFIC_PHONE_LEGACY_IDS, REVIEWED_UNSUPPORTED_REGION_LEGACY_IDS, REVIEWED_MISSING_HIERARCHY_LEGACY_IDS, CORE_MAPPINGS,
  CUSTOM_MAPPINGS, FOCUS_AREA, TENANT_ID, auditHierarchy, auditLegacyConflicts, auditMappings,
  decodeMixedEncoding, makePlan, parsePhone, parseSourceBytes, preservationSnapshot, readSource,
  writeFocusAreas,
} from './import-bnms-former-members.mjs';

test('pins former-member source shape and explicit non-importable records', { skip: !existsSync(FILE) }, () => {
  const source = readSource();
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(source.importRows.length, IMPORT_ROW_COUNT);
  assert.deepEqual(source.excluded.map((row) => row.legacyId), REVIEWED_EMAILLESS_LEGACY_IDS);
  assert.deepEqual(source.suppressedPhones.map((row) => row.legacyId), REVIEWED_SCIENTIFIC_PHONE_LEGACY_IDS);
  assert.deepEqual(source.unsupportedRegions.map((row) => row.legacyId), REVIEWED_UNSUPPORTED_REGION_LEGACY_IDS);
  assert.deepEqual(source.missingHierarchy.map((row) => row.legacyId), REVIEWED_MISSING_HIERARCHY_LEGACY_IDS);
  assert.equal(source.blocked.length, 32);
  assert.equal(new Set(source.importRows.map((row) => row.email)).size, IMPORT_ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.legacyId)).size, ROW_COUNT);
});
test('mixed decoder preserves UTF-8 and isolated CP1252 without guessing phones', () => {
  assert.equal(decodeMixedEncoding(Buffer.concat([Buffer.from('I’m '), Buffer.from([0x96]), Buffer.from(' ready')])), 'I’m – ready');
  assert.throws(() => parsePhone('4.47811E+11', 'test'), /Scientific-notation/);
  assert.equal(parsePhone('07823 779775', 'test'), '07823 779775');
  assert.throws(() => decodeMixedEncoding(Buffer.from('bad \uFFFD')), /replacement/);
  assert.throws(() => decodeMixedEncoding(Buffer.from('Iâ€™m')), /mojibake/);
});
function bytesFrom(rows) {
  return Buffer.from(rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n'));
}
test('positional contract covers every column and rejects malformed identities and values', () => {
  const source = readSource();
  assert.deepEqual([...CORE_MAPPINGS.map((x) => x.column), ...CUSTOM_MAPPINGS.map((x) => x.column), 12, 13, 14, FOCUS_AREA.column].sort((a, b) => a - b), [...Array(COLUMN_COUNT).keys()]);
  const rows = [HEADERS, ...source.rows.map((r) => [...r.values])];
  const bad = (column, value, re) => { const copy = rows.map((r) => [...r]); copy[1][column] = value; assert.throws(() => parseSourceBytes(bytesFrom(copy), { verifyFingerprint: false }), re); };
  bad(1, '31/02/2025', /Invalid/); bad(8, 'not-an-email', /invalid Email/);
  bad(16, 'yes', /invalid SRP/); bad(12, 'not-a-uuid', /invalid UUID/);
  bad(11, '4.4E+11', /scientific-phone suppression/);
  const duplicateEmail = rows.map((r) => [...r]); duplicateEmail[2][8] = duplicateEmail[1][8].toUpperCase();
  assert.throws(() => parseSourceBytes(bytesFrom(duplicateEmail), { verifyFingerprint: false }), /Duplicate email/);
  const duplicateLegacy = rows.map((r) => [...r]); duplicateLegacy[2][0] = duplicateLegacy[1][0];
  assert.throws(() => parseSourceBytes(bytesFrom(duplicateLegacy), { verifyFingerprint: false }), /Duplicate legacyId/);
});
test('source retains exact pipe qualifications and Focus Area names', () => {
  const source = readSource();
  assert.ok(source.importRows.some((r) => r.values[17] === 'BSc|FRCR|MBChb|MSc|PhD'));
  assert.ok(source.importRows.some((r) => r.values[18].includes('Physics – imaging science')));
});
function fieldFixture(source) {
  return CUSTOM_MAPPINGS.map((m) => ({
    ...m, tenant_id: TENANT_ID, entity_scope: 'member', field_type: m.type, is_active: true,
    options: m.type === 'dropdown' ? [...new Set(source.importRows.map((r) => r.values[m.column]).filter(Boolean))].map((value) => ({ value, label: value })) : null,
  }));
}
test('member field audits scope before ambiguity and fail closed on controlled option drift', () => {
  const source = readSource(), fields = fieldFixture(source);
  const region = fields.find((f) => f.name === 'member_region');
  assert.doesNotThrow(() => auditMappings([...fields, { ...region, id: 'org-region', entity_scope: 'organization' }], source));
  assert.throws(() => auditMappings(fields.map((f) => f.name === 'member_region' ? { ...f, options: [] } : f), source), /Unsupported "Region"/);
  assert.throws(() => auditMappings(fields.map((f) => f.name === 'member_region' ? { ...f, entity_scope: 'organization' } : f), source), /unambiguous/);
});
test('hierarchy ownership, department parent chain, and assignment edge transitions are fail-closed', () => {
  const base = readSource(), groupRow = base.importRows.find((r) => r.values[12]), orgRow = base.importRows.find((r) => r.values[13]), depRow = base.importRows.find((r) => r.values[14]);
  const def = { id: 'member-def', tenant_id: TENANT_ID, relationship_key: 'members', source_kind: 'custom_object', source_custom_object_id: 'dep-object', target_kind: 'member', cardinality: 'many_to_many', is_required: false, status: 'active' };
  const parentDef = { ...def, id: 'parent-def', relationship_key: 'organisation', target_kind: 'organization', cardinality: 'many_to_one', is_required: true };
  const hierarchy = auditHierarchy({ ...base, importRows: [groupRow, orgRow, depRow] }, {
    groups: [{ id: groupRow.values[12], tenant_id: TENANT_ID }],
    organizations: [{ id: orgRow.values[13], tenant_id: TENANT_ID }, { id: 'dep-org', tenant_id: TENANT_ID }],
    departments: [{ id: depRow.values[14], tenant_id: TENANT_ID, custom_object_id: 'dep-object', archived_at: null }],
    relationshipDefinitions: [def, parentDef],
    parentEdges: [{ relationship_definition_id: 'parent-def', source_record_id: depRow.values[14], target_record_id: 'dep-org', archived_at: null }],
  });
  assert.equal(hierarchy.departmentParents.get(depRow.values[14]), 'dep-org');
  assert.throws(() => auditHierarchy({ ...base, importRows: [groupRow] }, { groups: [{ id: groupRow.values[12], tenant_id: 'other' }], relationshipDefinitions: [def, parentDef] }), /outside BNMS/);
  const mappings = auditMappings(fieldFixture(base), base);
  const member = { id: 'm', tenant_id: TENANT_ID, email: groupRow.email, organization_id: 'old-org', organization_group_id: null };
  let plan = makePlan({ ...base, importRows: [groupRow] }, { members: [member], preferenceValues: [], memberCategories: [], memberEdges: [] }, mappings, hierarchy, FOCUS_AREA);
  assert.equal(plan.items[0].patch.organization_group_id, groupRow.values[12]); assert.equal(plan.items[0].patch.organization_id, null);
  const om = { ...member, email: orgRow.email, organization_id: null, organization_group_id: 'old-group' };
  plan = makePlan({ ...base, importRows: [orgRow] }, { members: [om], preferenceValues: [], memberCategories: [], memberEdges: [] }, mappings, hierarchy, FOCUS_AREA);
  assert.equal(plan.items[0].patch.organization_id, orgRow.values[13]); assert.equal(plan.items[0].patch.organization_group_id, null);
  const dm = { ...member, email: depRow.email };
  plan = makePlan({ ...base, importRows: [depRow] }, { members: [dm], preferenceValues: [], memberCategories: [], memberEdges: [] }, mappings, hierarchy, FOCUS_AREA);
  assert.equal(plan.items[0].edgeAction, 'insert');
  plan = makePlan({ ...base, importRows: [depRow] }, { members: [dm], preferenceValues: [], memberCategories: [], memberEdges: [{ target_record_id: 'm', relationship_definition_id: 'member-def', source_record_id: depRow.values[14], archived_at: null }] }, mappings, hierarchy, FOCUS_AREA);
  assert.equal(plan.items[0].edgeAction, 'unchanged');
  plan = makePlan({ ...base, importRows: [depRow] }, {
    members: [dm], preferenceValues: [], memberCategories: [],
    memberEdges: [
      { id: 'requested', target_record_id: 'm', relationship_definition_id: 'member-def', source_record_id: depRow.values[14], archived_at: null },
      { id: 'additional', target_record_id: 'm', relationship_definition_id: 'member-def', source_record_id: 'another-department', archived_at: null },
    ],
  }, mappings, hierarchy, FOCUS_AREA);
  assert.equal(plan.items[0].edgeAction, 'unchanged');
  assert.deepEqual(plan.items[0].conflictingEdges, []);
  assert.equal(plan.items[0].activeDepartmentEdges.length, 2);
});
test('no-reference preserves assignments and legacy collisions reject a different member', () => {
  const source = readSource(), row = source.importRows.find((r) => !r.values[12] && !r.values[13] && !r.values[14]);
  const mappings = auditMappings(fieldFixture(source), source);
  const member = { id: 'm', tenant_id: TENANT_ID, email: row.email, organization_id: 'keep-org', organization_group_id: 'keep-group' };
  const plan = makePlan({ ...source, importRows: [row] }, { members: [member], preferenceValues: [], memberCategories: [], memberEdges: [] }, mappings, { memberDefinition: { id: 'member-def' }, departmentParents: new Map() }, FOCUS_AREA);
  assert.ok(!Object.hasOwn(plan.items[0].patch, 'organization_id')); assert.ok(!Object.hasOwn(plan.items[0].patch, 'organization_group_id'));
  assert.throws(() => auditLegacyConflicts({ ...source, importRows: [row] }, { members: [member], legacyValues: [{ value: row.legacyId, member_id: 'other' }] }), /conflicts/);
});
function snapshotDb(data) {
  class Query {
    constructor(table) { this.table = table; }
    select() { return this; } eq() { return this; } in() { return this; }
    order() { return this; } range() { return this; }
    then(resolve) { return Promise.resolve({ data: data[this.table] || [], error: null }).then(resolve); }
  }
  return { from: (table) => new Query(table) };
}
test('preservation permits only additive Department and Focus inserts', async () => {
  const row = { sourceRow: 2, email: 'member@example.test', legacyId: '1', values: Array(19).fill('') };
  row.values[8] = row.email; row.values[14] = 'department';
  const member = { id: 'member', tenant_id: TENANT_ID, email: row.email, mobile: 'protected blank' };
  const existingEdge = { id: 'existing-edge', relationship_definition_id: 'member-def', source_record_id: 'old-department', target_record_id: member.id, archived_at: null };
  const unrelatedEdge = { id: 'unrelated-edge', relationship_definition_id: 'member-def', source_record_id: 'other', target_record_id: 'outside', archived_at: null };
  const plan = { items: [{
    row, member, departmentId: 'department', edgeAction: 'insert', conflictingEdges: [],
    focusAreas: [{ name: 'Bone', action: 'insert' }],
  }] };
  const data = {
    member: [member], member_preference_value: [],
    custom_object_relationship: [existingEdge, unrelatedEdge],
    member_resource_category: [{ id: 'existing', member_id: member.id, resource_category_id: FOCUS_AREA.id, subcategory_name: 'Lung' }],
  };
  const args = [snapshotDb(data), { rows: [row] }, [], { memberDefinition: { id: 'member-def' } }, plan];
  const before = await preservationSnapshot(...args);
  data.custom_object_relationship.push({ id: 'new-edge', relationship_definition_id: 'member-def', source_record_id: 'department', target_record_id: member.id, archived_at: null });
  data.member_resource_category.push({ id: 'new-focus', member_id: member.id, resource_category_id: FOCUS_AREA.id, subcategory_name: 'Bone' });
  assert.equal((await preservationSnapshot(...args, before.memberIds)).digest, before.digest);
  data.custom_object_relationship[0].archived_at = '2026-09-04T00:00:00Z';
  assert.notEqual((await preservationSnapshot(...args, before.memberIds)).digest, before.digest);
  data.custom_object_relationship[0].archived_at = null;
  data.member_resource_category[0].subcategory_name = 'Changed existing';
  assert.notEqual((await preservationSnapshot(...args, before.memberIds)).digest, before.digest);
});
function focusDb({ insertData, insertError = null, deleted = [] }) {
  class Query {
    constructor(table, operation = 'read') { this.table = table; this.operation = operation; }
    select() {
      if (this.operation === 'insert') return Promise.resolve({ data: insertData, error: insertError });
      if (this.operation === 'delete') return Promise.resolve({ data: deleted, error: null });
      return this;
    }
    eq() { return this; } order() { return this; } range() { return this; } in() { return this; }
    insert() { this.operation = 'insert'; return this; } delete() { this.operation = 'delete'; return this; }
    then(resolve) { return Promise.resolve({ data: [{ id: 'member', email: 'member@example.test', tenant_id: TENANT_ID }], error: null }).then(resolve); }
  }
  return { from: (table) => new Query(table) };
}
test('Focus rollback handles pre-commit zero, incomplete committed cleanup, and rejects partial cleanup', async () => {
  const item = { row: { email: 'member@example.test' }, focusAreas: [{ name: 'Bone', action: 'insert' }] };
  let journal = [];
  await assert.rejects(writeFocusAreas(focusDb({ insertData: null, insertError: { message: 'precommit' }, deleted: [] }), { items: [item] }, FOCUS_AREA, journal), /precommit/);
  await assert.doesNotReject(journal[0].rollback());
  journal = [];
  await assert.rejects(writeFocusAreas(focusDb({ insertData: [], deleted: [{ id: 'deleted' }] }), { items: [item] }, FOCUS_AREA, journal), /returned 0\/1/);
  await assert.doesNotReject(journal[0].rollback());
  const two = { ...item, focusAreas: [{ name: 'Bone', action: 'insert' }, { name: 'Lung', action: 'insert' }] };
  journal = [];
  await assert.rejects(writeFocusAreas(focusDb({ insertData: [], deleted: [{ id: 'only-one' }] }), { items: [two] }, FOCUS_AREA, journal));
  await assert.rejects(journal[0].rollback(), /incomplete/);
});