import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemberDepartmentError, resolveMemberDepartmentDefinition, validateDepartmentIds,
  resolveDepartmentMemberIds, enrichMembersWithDepartments, listDepartmentOptions,
} from './memberDepartments.js';

const tenant = 'tenant-a';
function db(seed) {
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.slice = null; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
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
    { id: 'member-def', tenant_id: tenant, relationship_key: 'members', status: 'active', source_kind: 'custom_object', source_custom_object_id: 'dept-object', target_kind: 'member', target_custom_object_id: null, cardinality: 'one_to_many' },
    { id: 'org-def', tenant_id: tenant, relationship_key: 'organisation', status: 'active', is_required: true, source_kind: 'custom_object', source_custom_object_id: 'dept-object', target_kind: 'organization' },
  ],
  custom_object_record: [{ id: 'dept-1', tenant_id: tenant, custom_object_id: 'dept-object', archived_at: null, data: { name: 'Operations' } }],
  custom_object_relationship: [
    { tenant_id: tenant, relationship_definition_id: 'member-def', source_record_id: 'dept-1', target_record_id: 'member-1', archived_at: null },
    { tenant_id: tenant, relationship_definition_id: 'org-def', source_record_id: 'dept-1', target_record_id: 'org-1', archived_at: null },
  ],
  preference_field: [{ id: 'name-field', tenant_id: tenant, name: 'name' }],
  organization: [{ id: 'org-1', tenant_id: tenant, name: 'Acme' }],
});

test('optional schema resolution preserves legacy tenants', async () => {
  const client = db({ custom_object_definition: [], custom_object_relationship_definition: [] });
  assert.equal(await resolveMemberDepartmentDefinition(client, tenant), null);
  assert.deepEqual(await enrichMembersWithDepartments(client, tenant, [{ id: 'm' }]), [{ id: 'm', department: null, department_id: null }]);
  assert.deepEqual(await listDepartmentOptions(client, tenant), []);
  await assert.rejects(() => validateDepartmentIds(client, tenant, ['x']), MemberDepartmentError);
});

test('schema ambiguity and malformed matching relationship fail closed', async () => {
  const ambiguous = base();
  ambiguous.custom_object_definition.push({ ...ambiguous.custom_object_definition[0], id: 'two' });
  await assert.rejects(() => resolveMemberDepartmentDefinition(db(ambiguous), tenant), MemberDepartmentError);
  const malformed = base();
  malformed.custom_object_relationship_definition[0].cardinality = 'many_to_many';
  await assert.rejects(() => resolveMemberDepartmentDefinition(db(malformed), tenant), MemberDepartmentError);
});

test('department ID validation rejects cross-tenant IDs and resolves member IDs', async () => {
  const seed = base();
  seed.custom_object_record.push({ id: 'foreign', tenant_id: 'other', custom_object_id: 'dept-object', archived_at: null, data: {} });
  const client = db(seed);
  await assert.rejects(() => validateDepartmentIds(client, tenant, ['foreign']), MemberDepartmentError);
  assert.deepEqual(await resolveDepartmentMemberIds(client, tenant, ['dept-1']), ['member-1']);
});

test('options filter by parent organisation and enrichment is batched', async () => {
  const client = db(base());
  assert.deepEqual(await listDepartmentOptions(client, tenant, ['org-1']), [{
    id: 'dept-1', name: 'Operations', organization_id: 'org-1', organization_name: 'Acme',
  }]);
  assert.deepEqual(await listDepartmentOptions(client, tenant, ['other']), []);
  const rows = await enrichMembersWithDepartments(client, tenant, [
    { id: 'member-1', organization_id: 'org-1' }, { id: 'member-2', organization_id: 'org-1' },
  ]);
  assert.deepEqual(rows.map(row => row.department_id), ['dept-1', null]);
  assert.equal(rows[0].department.name, 'Operations');
});