import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemberDepartmentError, resolveMemberDepartmentDefinition, validateDepartmentIds,
  resolveDepartmentMemberIds, enrichMembersWithDepartments, listDepartmentOptions,
} from './memberDepartments.js';

const tenant = 'tenant-a';
function db(seed, onIn = () => {}) {
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.slice = null; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    in(key, values) {
      onIn({ table: this.table, key, values: [...values] });
      this.filters.push(row => values.includes(row[key]));
      return this;
    }
    is(key, value) { this.filters.push(row => row[key] === value); return this; }
    range(from, to) { this.slice = [from, to + 1]; return this; }
    result() {
      let data = (seed[this.table] || []).filter(row => this.filters.every(f => f(row)));
      if (this.slice) data = data.slice(...this.slice);
      return { data: structuredClone(data), error: null };
    }
    maybeSingle() { return Promise.resolve({ ...this.result(), data: this.result().data[0] || null }); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  return { from: table => new Query(table) };
}
const base = () => ({
  custom_object_definition: [{ id: 'dept-object', tenant_id: tenant, object_key: 'org_department', status: 'active', primary_display_field_id: 'name-field' }],
  custom_object_relationship_definition: [
    { id: 'member-def', tenant_id: tenant, relationship_key: 'members', status: 'active', source_kind: 'custom_object', source_custom_object_id: 'dept-object', target_kind: 'member', target_custom_object_id: null, cardinality: 'many_to_many' },
    { id: 'org-def', tenant_id: tenant, relationship_key: 'organisation', status: 'active', is_required: true, source_kind: 'custom_object', source_custom_object_id: 'dept-object', target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one' },
  ],
  custom_object_record: [{ id: 'dept-1', tenant_id: tenant, custom_object_id: 'dept-object', archived_at: null, data: { name: 'Operations' } }],
  custom_object_relationship: [
    { tenant_id: tenant, relationship_definition_id: 'member-def', source_record_id: 'dept-1', target_record_id: 'member-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'org-def', source_record_id: 'dept-1', target_record_id: 'org-1', archived_at: null },
  ],
  preference_field: [{ id: 'name-field', tenant_id: tenant, name: 'name' }],
  organization: [{ id: 'org-1', tenant_id: tenant, name: 'Acme' }],
  member: [{ id: 'member-1', tenant_id: tenant, organization_id: 'org-1' }],
});

test('optional schema resolution preserves legacy tenants', async () => {
  const client = db({ custom_object_definition: [], custom_object_relationship_definition: [] });
  assert.equal(await resolveMemberDepartmentDefinition(client, tenant), null);
  assert.deepEqual(await enrichMembersWithDepartments(client, tenant, [{ id: 'm' }]), [{ id: 'm', departments: [], department_ids: [] }]);
  assert.deepEqual(await listDepartmentOptions(client, tenant), []);
  await assert.rejects(() => validateDepartmentIds(client, tenant, ['x']), MemberDepartmentError);
});

test('schema ambiguity and malformed matching relationship fail closed', async () => {
  const ambiguous = base();
  ambiguous.custom_object_definition.push({ ...ambiguous.custom_object_definition[0], id: 'two' });
  await assert.rejects(() => resolveMemberDepartmentDefinition(db(ambiguous), tenant), MemberDepartmentError);
  const malformed = base();
  malformed.custom_object_relationship_definition[0].cardinality = 'many_to_one';
  await assert.rejects(() => resolveMemberDepartmentDefinition(db(malformed), tenant), MemberDepartmentError);
});

test('legacy one-to-many Department schemas remain readable', async () => {
  const seed = base();
  seed.custom_object_relationship_definition[0].cardinality = 'one_to_many';
  const schema = await resolveMemberDepartmentDefinition(db(seed), tenant, { required: true });
  assert.equal(schema.definitionId, 'member-def');
  const members = await enrichMembersWithDepartments(
    db(seed),
    tenant,
    [{ id: 'member-1', organization_id: 'org-1' }],
  );
  assert.deepEqual(members[0].department_ids, ['dept-1']);
});

test('department ID validation rejects cross-tenant IDs and resolves member IDs', async () => {
  const seed = base();
  seed.custom_object_record.push({ id: 'foreign', tenant_id: 'other', custom_object_id: 'dept-object', archived_at: null, data: {} });
  const client = db(seed);
  await assert.rejects(() => validateDepartmentIds(client, tenant, ['foreign']), MemberDepartmentError);
  assert.deepEqual(await resolveDepartmentMemberIds(client, tenant, ['dept-1']), ['member-1']);
});

test('department filtering uses ANY semantics once per member and ignores invalid historical edges', async () => {
  const seed = base();
  seed.custom_object_record.push(
    { id: 'dept-2', tenant_id: tenant, custom_object_id: 'dept-object', archived_at: null, data: { name: 'Imaging' } },
    { id: 'dept-wrong-org', tenant_id: tenant, custom_object_id: 'dept-object', archived_at: null, data: { name: 'Wrong org' } },
  );
  seed.custom_object_relationship.push(
    { tenant_id: tenant, relationship_definition_id: 'member-def', source_record_id: 'dept-2', target_record_id: 'member-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'member-def', source_record_id: 'dept-wrong-org', target_record_id: 'member-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'member-def', source_record_id: 'dept-wrong-org', target_record_id: 'member-stale', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'org-def', source_record_id: 'dept-2', target_record_id: 'org-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'org-def', source_record_id: 'dept-wrong-org', target_record_id: 'org-2', archived_at: null },
  );
  seed.member.push({ id: 'member-stale', tenant_id: tenant, organization_id: 'org-1' });
  assert.deepEqual(
    await resolveDepartmentMemberIds(db(seed), tenant, ['dept-1', 'dept-2', 'dept-wrong-org']),
    ['member-1'],
  );
  assert.deepEqual(
    await resolveDepartmentMemberIds(db(seed), tenant, ['dept-wrong-org']),
    [],
  );
});

test('options filter by parent organisation and enrichment returns every department in name order', async () => {
  const seed = base();
  seed.custom_object_record.push(
    { id: 'dept-2', tenant_id: tenant, custom_object_id: 'dept-object', archived_at: null, data: { name: 'Imaging' } },
    { id: 'dept-foreign-org', tenant_id: tenant, custom_object_id: 'dept-object', archived_at: null, data: { name: 'Wrong org' } },
  );
  seed.custom_object_relationship.push(
    { tenant_id: tenant, relationship_definition_id: 'member-def', source_record_id: 'dept-2', target_record_id: 'member-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'member-def', source_record_id: 'dept-foreign-org', target_record_id: 'member-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'org-def', source_record_id: 'dept-2', target_record_id: 'org-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'org-def', source_record_id: 'dept-foreign-org', target_record_id: 'org-2', archived_at: null },
  );
  seed.organization.push({ id: 'org-2', tenant_id: tenant, name: 'Other' });
  const client = db(seed);
  assert.deepEqual(await listDepartmentOptions(client, tenant, ['org-1']), [
    { id: 'dept-2', name: 'Imaging', organization_id: 'org-1', organization_name: 'Acme' },
    { id: 'dept-1', name: 'Operations', organization_id: 'org-1', organization_name: 'Acme' },
  ]);
  assert.deepEqual(await listDepartmentOptions(client, tenant, ['other']), []);
  const rows = await enrichMembersWithDepartments(client, tenant, [
    { id: 'member-1', organization_id: 'org-1' }, { id: 'member-2', organization_id: 'org-1' },
  ]);
  assert.deepEqual(rows.map(row => row.department_ids), [['dept-2', 'dept-1'], []]);
  assert.deepEqual(rows[0].departments.map(department => department.name), ['Imaging', 'Operations']);
  assert.equal(rows[0].departments.some(department => department.id === 'dept-foreign-org'), false);
});

test('export-sized member enrichment batches UUID filters and paginates every batch', async () => {
  const seed = base();
  const members = Array.from({ length: 925 }, (_, index) => ({
    id: `member-${index + 1}`,
    organization_id: 'org-1',
  }));
  seed.member = members.map(member => ({ ...member, tenant_id: tenant }));

  const departmentCount = 11;
  seed.custom_object_record = Array.from({ length: departmentCount }, (_, index) => ({
    id: `dept-${index + 1}`,
    tenant_id: tenant,
    custom_object_id: 'dept-object',
    archived_at: null,
    data: { name: `Department ${String(index + 1).padStart(2, '0')}` },
  }));
  seed.custom_object_relationship = [
    ...seed.custom_object_record.map(department => ({
      tenant_id: tenant,
      relationship_definition_id: 'org-def',
      source_record_id: department.id,
      target_record_id: 'org-1',
      archived_at: null,
    })),
    ...members.slice(0, 100).flatMap(member => seed.custom_object_record.map(department => ({
      tenant_id: tenant,
      relationship_definition_id: 'member-def',
      source_record_id: department.id,
      target_record_id: member.id,
      archived_at: null,
    }))),
  ];

  const inCalls = [];
  const enriched = await enrichMembersWithDepartments(
    db(seed, call => inCalls.push(call)),
    tenant,
    members,
  );

  const memberEdgeCalls = inCalls.filter(call =>
    call.table === 'custom_object_relationship'
    && call.key === 'target_record_id');
  assert.equal(memberEdgeCalls.length, 11);
  assert.ok(memberEdgeCalls.every(call => call.values.length <= 100));
  assert.deepEqual(memberEdgeCalls[0].values, memberEdgeCalls[1].values);
  const distinctMemberBatches = [...new Map(
    memberEdgeCalls.map(call => [JSON.stringify(call.values), call.values]),
  ).values()];
  assert.equal(distinctMemberBatches.length, 10);
  distinctMemberBatches.forEach((batch, index) => {
    assert.deepEqual(batch, members.slice(index * 100, (index + 1) * 100).map(member => member.id));
  });
  assert.deepEqual(
    new Set(memberEdgeCalls.flatMap(call => call.values)),
    new Set(members.map(member => member.id)),
  );
  assert.ok(enriched.slice(0, 100).every(member => member.departments.length === departmentCount));
  assert.deepEqual(enriched[100].departments, []);
});

test('large Department option sets batch record and organisation filters', async () => {
  const seed = base();
  const optionCount = 205;
  seed.custom_object_record = Array.from({ length: optionCount }, (_, index) => ({
    id: `dept-${index + 1}`,
    tenant_id: tenant,
    custom_object_id: 'dept-object',
    archived_at: null,
    data: { name: `Department ${String(index + 1).padStart(3, '0')}` },
  }));
  seed.organization = Array.from({ length: optionCount }, (_, index) => ({
    id: `org-${index + 1}`,
    tenant_id: tenant,
    name: `Organisation ${String(index + 1).padStart(3, '0')}`,
  }));
  seed.custom_object_relationship = seed.custom_object_record.map((department, index) => ({
    tenant_id: tenant,
    relationship_definition_id: 'org-def',
    source_record_id: department.id,
    target_record_id: seed.organization[index].id,
    archived_at: null,
  }));

  const inCalls = [];
  const options = await listDepartmentOptions(db(seed, call => inCalls.push(call)), tenant);
  const recordCalls = inCalls.filter(call => call.table === 'custom_object_record' && call.key === 'id');
  const organisationCalls = inCalls.filter(call => call.table === 'organization' && call.key === 'id');

  assert.equal(options.length, optionCount);
  assert.equal(recordCalls.length, 3);
  assert.equal(organisationCalls.length, 3);
  assert.ok([...recordCalls, ...organisationCalls].every(call => call.values.length <= 100));
  assert.equal(new Set(recordCalls.flatMap(call => call.values)).size, optionCount);
  assert.equal(new Set(organisationCalls.flatMap(call => call.values)).size, optionCount);
});