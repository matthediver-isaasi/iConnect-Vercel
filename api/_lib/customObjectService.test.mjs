import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CustomObjectHttpError,
  createCustomObjectService,
} from './customObjectService.js';

const tenantId = '22222222-2222-4222-8222-222222222222';
const objectId = '11111111-1111-4111-8111-111111111111';
const roleId = '33333333-3333-4333-8333-333333333333';

function mockDb(seed = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [
    name, rows.map((row) => structuredClone(row)),
  ]));
  const calls = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.operation = 'select';
      this.payload = null;
      this.wantCount = false;
    }

    select(_columns, options = {}) { this.wantCount = options.count === 'exact'; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); calls.push({ table: this.table, type: 'eq', column, value }); return this; }
    neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
    is(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    or() { return this; }
    order() { return this; }
    range(from, to) { this.slice = [from, to + 1]; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    upsert(payload) { this.operation = 'upsert'; this.payload = payload; return this; }

    execute() {
      tables[this.table] ||= [];
      if (this.operation === 'insert') {
        const row = { id: `${this.table}-${tables[this.table].length + 1}`, ...structuredClone(this.payload) };
        tables[this.table].push(row);
        return { data: row, error: null };
      }
      if (this.operation === 'upsert') {
        let row = tables[this.table].find((candidate) =>
          candidate.tenant_id === this.payload.tenant_id
          && candidate.custom_object_id === this.payload.custom_object_id
          && candidate.role_id === this.payload.role_id);
        if (row) Object.assign(row, structuredClone(this.payload));
        else {
          row = { id: `${this.table}-${tables[this.table].length + 1}`, ...structuredClone(this.payload) };
          tables[this.table].push(row);
        }
        return { data: row, error: null };
      }
      let rows = tables[this.table].filter((row) => this.filters.every((filter) => filter(row)));
      if (this.operation === 'update') {
        rows.forEach((row) => Object.assign(row, structuredClone(this.payload)));
      }
      const count = rows.length;
      if (this.slice) rows = rows.slice(...this.slice);
      return { data: structuredClone(rows), error: null, count: this.wantCount ? count : null };
    }

    async single() {
      const result = this.execute();
      return { ...result, data: Array.isArray(result.data) ? result.data[0] : result.data };
    }
    async maybeSingle() {
      const result = this.execute();
      return { ...result, data: Array.isArray(result.data) ? (result.data[0] || null) : result.data };
    }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }

  return {
    from(table) { calls.push({ table, type: 'from' }); return new Query(table); },
    tables,
    calls,
  };
}

function context(overrides = {}) {
  return {
    isAuthenticated: true,
    tenantId,
    memberId: 'member-1',
    roleId,
    ...overrides,
  };
}

function object(overrides = {}) {
  return {
    id: objectId, tenant_id: tenantId, object_key: 'departments',
    status: 'active', primary_display_field_id: null, ...overrides,
  };
}

function field(overrides = {}) {
  return {
    id: 'field-1', tenant_id: tenantId, custom_object_id: objectId,
    entity_scope: 'custom_object', name: 'headcount', label: 'Headcount',
    field_type: 'number', is_required: true, is_active: true, display_order: 1,
    ...overrides,
  };
}

test('service denies unauthenticated, mismatched, and missing-tenant contexts', () => {
  const db = mockDb();
  assert.throws(
    () => createCustomObjectService({ db, context: { isAuthenticated: false } }),
    (error) => error instanceof CustomObjectHttpError && error.status === 401,
  );
  assert.throws(
    () => createCustomObjectService({ db, context: context({ tenantMismatch: true }) }),
    (error) => error.status === 409,
  );
  assert.throws(
    () => createCustomObjectService({ db, context: context({ tenantId: null }) }),
    (error) => error.status === 400,
  );
});

test('all object reads are tenant scoped and cross-tenant IDs are invisible', async () => {
  const db = mockDb({
    custom_object_definition: [object(), object({ tenant_id: 'other-tenant' })],
    custom_object_role_permission: [{
      tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true,
    }],
  });
  const service = createCustomObjectService({ db, context: context() });
  await service.getObject(objectId);
  assert.ok(db.calls.some((call) => call.table === 'custom_object_definition'
    && call.type === 'eq' && call.column === 'tenant_id' && call.value === tenantId));
  const otherService = createCustomObjectService({ db, context: context({ tenantId: 'third-tenant' }) });
  await assert.rejects(() => otherService.getObject(objectId), (error) => error.status === 404);
});

test('role permission is deny-by-default while an administrator bypasses it', async () => {
  const db = mockDb({ custom_object_definition: [object()] });
  await assert.rejects(
    () => createCustomObjectService({ db, context: context() }).getObject(objectId),
    (error) => error.status === 403,
  );
  assert.equal(
    (await createCustomObjectService({ db, context: context(), isAdmin: true }).getObject(objectId)).id,
    objectId,
  );
});

test('record creation coerces typed JSONB, rejects invalid values, and authors mutation identity', async () => {
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [field()],
    custom_object_role_permission: [{
      tenant_id: tenantId, custom_object_id: objectId, role_id: roleId,
      can_create_records: true,
    }],
  });
  const service = createCustomObjectService({
    db,
    context: context({ memberId: 'trusted-member', tenantUserId: null }),
  });
  const created = await service.createRecord(objectId, {
    data: { headcount: '42' },
    created_by: 'forged',
    actor_id: 'forged',
  });
  assert.equal(created.data.headcount, 42);
  assert.equal(created.created_by, 'trusted-member');

  await assert.rejects(
    () => service.createRecord(objectId, { data: { headcount: '4.2' } }),
    (error) => error.status === 400 && error.details[0].field === 'headcount',
  );
});

test('relationship creation validates endpoint kind/object and authors mutation identity', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetObjectId, object_key: 'locations' }),
    ],
    custom_object_role_permission: [{
      tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_edit_records: true,
    }, {
      tenant_id: tenantId, custom_object_id: targetObjectId, role_id: roleId, can_edit_records: true,
    }],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'custom_object', target_custom_object_id: targetObjectId,
    }],
    custom_object_record: [
      { id: 'source-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null },
      { id: 'target-1', tenant_id: tenantId, custom_object_id: targetObjectId, archived_at: null },
      { id: 'wrong-target', tenant_id: tenantId, custom_object_id: objectId, archived_at: null },
    ],
  });
  const service = createCustomObjectService({ db, context: context() });
  const relation = await service.createRelationship(objectId, {
    relationship_definition_id: definitionId,
    source_record_id: 'source-1',
    target_record_id: 'target-1',
    created_by: 'forged',
  });
  assert.equal(relation.created_by, 'member-1');
  await assert.rejects(
    () => service.createRelationship(objectId, {
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'wrong-target',
    }),
    (error) => error.status === 400 && /different Custom Object/.test(error.message),
  );
});