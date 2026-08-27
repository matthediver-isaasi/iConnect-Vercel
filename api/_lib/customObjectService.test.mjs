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
      this.orders = [];
    }

    select(_columns, options = {}) { this.wantCount = options.count === 'exact'; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); calls.push({ table: this.table, type: 'eq', column, value }); return this; }
    neq(column, value) {
      this.filters.push((row) => this.value(row, column) !== value);
      calls.push({ table: this.table, type: 'neq', column, value });
      return this;
    }
    is(column, value) { this.filters.push((row) => this.value(row, column) === value); return this; }
    value(row, column) {
      const match = column.match(/^data->>?([a-z][a-z0-9_]*)$/);
      return match ? (row.data?.[match[1]] ?? null) : row[column];
    }
    in(column, values) {
      this.filters.push((row) => values.includes(this.value(row, column)));
      calls.push({ table: this.table, type: 'in', column, values });
      return this;
    }
    filter(column, operator, value) {
      const expected = column.includes('->>') ? value : JSON.parse(value);
      this.filters.push((row) => {
        const actual = this.value(row, column);
        if (operator === 'eq') return actual === expected;
        if (operator === 'gte') return actual >= expected;
        if (operator === 'lte') return actual <= expected;
        if (operator === 'ilike') return String(actual ?? '').toLowerCase().includes(String(expected).replaceAll('*', '').toLowerCase());
        return true;
      });
      calls.push({ table: this.table, type: 'filter', column, operator, value });
      return this;
    }
    ilike(column, value) {
      const search = String(value).replaceAll('%', '').toLowerCase();
      this.filters.push((row) => String(this.value(row, column) ?? '').toLowerCase().includes(search));
      return this;
    }
    not(column, operator, value) {
      if (operator === 'cs') {
        const excluded = JSON.parse(value);
        this.filters.push((row) => !excluded.some((item) => (this.value(row, column) || []).includes(item)));
      } else if (operator === 'is') {
        this.filters.push((row) => this.value(row, column) !== value);
      }
      calls.push({ table: this.table, type: 'not', column, operator, value });
      return this;
    }
    or(expression) { calls.push({ table: this.table, type: 'or', expression }); return this; }
    order(column, options = {}) {
      this.orders.push({ column, ascending: options.ascending !== false });
      calls.push({ table: this.table, type: 'order', column, ...options });
      return this;
    }
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
      if (this.orders.length > 0) {
        rows.sort((left, right) => {
          for (const order of this.orders) {
            const a = this.value(left, order.column);
            const b = this.value(right, order.column);
            if (a === b) continue;
            if (a === null || a === undefined) return 1;
            if (b === null || b === undefined) return -1;
            const comparison = a < b ? -1 : 1;
            return order.ascending ? comparison : -comparison;
          }
          return 0;
        });
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
    rpc(name, args) {
      calls.push({ type: 'rpc', name, args });
      const execute = () => {
        if (name === 'custom_object_catalogue_counts') {
          const requestedIds = new Set(args.p_custom_object_ids);
          const counts = [...requestedIds].map((id) => ({
            custom_object_id: id,
            record_count: (tables.custom_object_record || []).filter((row) =>
              row.tenant_id === args.p_tenant_id
              && row.custom_object_id === id
              && row.archived_at === null).length,
            field_count: (tables.preference_field || []).filter((row) =>
              row.tenant_id === args.p_tenant_id
              && row.custom_object_id === id
              && row.entity_scope === 'custom_object'
              && row.is_active === true).length,
            relationship_count: new Set((tables.custom_object_relationship_definition || [])
              .filter((row) =>
                row.tenant_id === args.p_tenant_id
                && row.status !== 'archived'
                && (row.source_custom_object_id === id || row.target_custom_object_id === id))
              .map((row) => row.id)).size,
          }));
          return { data: counts, error: null };
        }
        if (name !== 'archive_custom_object_relationship') {
          return { data: null, error: { message: 'Unknown RPC' } };
        }
        const row = (tables.custom_object_relationship || []).find((candidate) =>
          candidate.tenant_id === args.p_tenant_id
          && candidate.id === args.p_relationship_id);
        if (!row) return { data: null, error: { code: 'P0002', message: 'Relationship edge not found for tenant' } };
        row.archived_at = args.p_archived_at;
        row.archived_by = args.p_archived_by;
        return { data: structuredClone(row), error: null };
      };
      return {
        async single() {
          return execute();
        },
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      };
    },
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
      can_view_records: true, can_create_records: true,
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
  assert.equal(created.created_by, 'member:trusted-member');

  await assert.rejects(
    () => service.createRecord(objectId, { data: { headcount: '4.2' } }),
    (error) => error.status === 400 && error.details[0].field === 'headcount',
  );
});

test('newly required fields preserve historical records until that field is supplied', async () => {
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [
      field({ name: 'headcount', is_required: false }),
      field({
        id: 'field-required',
        name: 'cost_centre',
        label: 'Cost centre',
        field_type: 'text',
        is_required: true,
      }),
    ],
    custom_object_record: [{
      id: 'record-1',
      tenant_id: tenantId,
      custom_object_id: objectId,
      data: { headcount: 10 },
      archived_at: null,
    }],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_edit_records: true,
    }],
  });
  const service = createCustomObjectService({ db, context: context() });
  const edited = await service.updateRecord(objectId, 'record-1', {
    data: { headcount: 11 },
  });
  assert.deepEqual(edited.data, { headcount: 11 });
  await assert.rejects(
    () => service.updateRecord(objectId, 'record-1', {
      data: { cost_centre: '' },
    }),
    (error) => error.status === 400
      && error.details.some((detail) => detail.field === 'cost_centre'),
  );
  assert.equal((await service.updateRecord(objectId, 'record-1', {
    data: { cost_centre: 'CC-100' },
  })).data.cost_centre, 'CC-100');
});

test('record create and update reject non-canonical country codes even when all countries are enabled', async () => {
  const countryField = field({
    id: 'country-field',
    name: 'country',
    label: 'Country',
    field_type: 'country',
    is_required: false,
    all_countries: true,
  });
  const countriesField = field({
    id: 'countries-field',
    name: 'countries',
    label: 'Countries',
    field_type: 'countries',
    is_required: false,
    all_countries: true,
  });
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [countryField, countriesField],
    custom_object_record: [{
      id: 'record-1',
      tenant_id: tenantId,
      custom_object_id: objectId,
      data: { country: 'GB', countries: ['GB'] },
      archived_at: null,
    }],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_create_records: true,
      can_edit_records: true,
    }],
  });
  const service = createCustomObjectService({ db, context: context() });
  await assert.rejects(
    () => service.createRecord(objectId, {
      data: { country: 'XX', countries: ['GB'] },
    }),
    (error) => error.status === 400
      && error.details.some((detail) => detail.field === 'country' && /ISO-2/.test(detail.message)),
  );
  await assert.rejects(
    () => service.createRecord(objectId, {
      data: { country: 'GB', countries: ['GB', 'XX'] },
    }),
    (error) => error.status === 400
      && error.details.some((detail) => detail.field === 'countries' && /ISO-2/.test(detail.message)),
  );
  await assert.rejects(
    () => service.updateRecord(objectId, 'record-1', {
      data: { country: 'XX' },
    }),
    (error) => error.status === 400
      && error.details.some((detail) => detail.field === 'country' && /ISO-2/.test(detail.message)),
  );
  await assert.rejects(
    () => service.updateRecord(objectId, 'record-1', {
      data: { countries: ['GB', 'XX'] },
    }),
    (error) => error.status === 400
      && error.details.some((detail) => detail.field === 'countries' && /ISO-2/.test(detail.message)),
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
      tenant_id: tenantId, custom_object_id: objectId, role_id: roleId,
      can_view_records: true, can_edit_records: true,
    }, {
      tenant_id: tenantId, custom_object_id: targetObjectId, role_id: roleId,
      can_view_records: true, can_edit_records: true,
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
    routed_side: 'source',
    routed_record_id: 'source-1',
    created_by: 'forged',
  });
  assert.equal(relation.created_by, 'member:member-1');
  await assert.rejects(
    () => service.createRelationship(objectId, {
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'wrong-target',
      routed_side: 'source',
      routed_record_id: 'source-1',
    }),
    (error) => error.status === 400 && /different Custom Object/.test(error.message),
  );
});

test('schema catalogue counts active tenant-scoped records, fields, and relationships', async () => {
  const otherObjectId = '44444444-4444-4444-8444-444444444444';
  const db = mockDb({
    custom_object_definition: [object(), object({ id: otherObjectId, object_key: 'offices' })],
    custom_object_record: [
      { tenant_id: tenantId, custom_object_id: objectId, archived_at: null },
      { tenant_id: tenantId, custom_object_id: objectId, archived_at: '2026-01-01' },
      { tenant_id: 'other-tenant', custom_object_id: objectId, archived_at: null },
    ],
    preference_field: [
      field(),
      field({ id: 'field-2', is_active: false }),
      field({ id: 'field-other', tenant_id: 'other-tenant' }),
    ],
    custom_object_relationship_definition: [{
      tenant_id: tenantId, source_custom_object_id: objectId,
      target_custom_object_id: otherObjectId, status: 'active',
    }, {
      tenant_id: tenantId, source_custom_object_id: objectId,
      target_custom_object_id: otherObjectId, status: 'archived',
    }, {
      tenant_id: 'other-tenant', source_custom_object_id: objectId,
      target_custom_object_id: otherObjectId, status: 'active',
    }],
  });
  const result = await createCustomObjectService({
    db,
    context: context(),
    canViewSchema: true,
  }).listObjects({});
  const row = result.data.find((item) => item.id === objectId);
  assert.deepEqual(
    [row.record_count, row.field_count, row.relationship_count],
    [1, 1, 1],
  );
});

test('activation requires a valid active field owned by the same tenant and object', async () => {
  const db = mockDb({
    custom_object_definition: [object({ status: 'draft' })],
    preference_field: [
      field({ id: 'inactive', is_active: false }),
      field({ id: 'invalid', field_type: 'unsupported' }),
      field({ id: 'valid', field_type: 'text', is_required: false }),
    ],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canManageSchema: true,
  });
  await assert.rejects(
    () => service.updateObject(objectId, { status: 'active', primary_display_field_id: 'inactive' }),
    (error) => error.status === 400 && /active field/.test(error.message),
  );
  await assert.rejects(
    () => service.updateObject(objectId, { status: 'active', primary_display_field_id: 'invalid' }),
    (error) => error.status === 400 && /invalid field definition/.test(error.message),
  );
  assert.equal(
    (await service.updateObject(objectId, {
      status: 'active',
      primary_display_field_id: 'valid',
    })).status,
    'active',
  );
});

test('field schema settings persist through the dedicated service', async () => {
  const db = mockDb({
    custom_object_definition: [object({ status: 'draft' })],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canManageSchema: true,
  });
  const countries = await service.createField(objectId, {
    name: 'operating_countries',
    label: 'Operating countries',
    field_type: 'countries',
    all_countries: false,
    selected_countries: ['GB', 'FR'],
    default_countries: ['GB'],
  });
  assert.deepEqual(countries.default_countries, ['GB']);

  const upload = await service.createField(objectId, {
    name: 'supporting_file',
    label: 'Supporting file',
    field_type: 'file',
    allowed_file_types: ['pdf'],
    public_access: true,
  });
  assert.equal(upload.public_access, true);
});

test('object and field keys are immutable and archived objects are terminal', async () => {
  const db = mockDb({
    custom_object_definition: [object({ status: 'draft' })],
    preference_field: [field()],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canManageSchema: true,
    now: () => '2026-08-25T00:00:00.000Z',
  });
  await assert.rejects(
    () => service.updateObject(objectId, { object_key: 'renamed' }),
    (error) => error.status === 400 && /cannot be changed/.test(error.message),
  );
  await assert.rejects(
    () => service.updateField(objectId, 'field-1', { name: 'renamed' }),
    (error) => error.status === 400 && /cannot be changed/.test(error.message),
  );
  const archived = await service.updateObject(objectId, {}, true);
  assert.equal(archived.status, 'archived');
  assert.equal(db.tables.custom_object_definition.length, 1);
  assert.deepEqual(await service.updateObject(objectId, {}, true), archived);
  await assert.rejects(
    () => service.updateObject(objectId, { singular_label: 'Changed' }),
    (error) => error.status === 409 && /cannot be modified/.test(error.message),
  );
});

test('database duplicate-key errors map to useful conflict responses', async () => {
  const db = {
    from() {
      return {
        insert() { return this; },
        select() { return this; },
        async single() {
          return {
            data: null,
            error: { code: '23505', constraint: 'custom_object_definition_tenant_key_unique' },
          };
        },
      };
    },
  };
  const service = createCustomObjectService({
    db,
    context: context(),
    canManageSchema: true,
  });
  await assert.rejects(
    () => service.createObject({
      object_key: 'departments',
      singular_label: 'Department',
      plural_label: 'Departments',
    }),
    (error) => error.status === 409 && /object key already exists/i.test(error.message),
  );
});

test('audit listing returns only tenant/object events and does not write audit rows itself', async () => {
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_audit_event: [
      { id: 'audit-1', tenant_id: tenantId, custom_object_id: objectId, action: 'updated' },
      { id: 'audit-2', tenant_id: 'other-tenant', custom_object_id: objectId, action: 'updated' },
    ],
  });
  const result = await createCustomObjectService({
    db,
    context: context(),
    canViewSchema: true,
  }).listAudit(objectId, {});
  assert.deepEqual(result.data.map((event) => event.id), ['audit-1']);
  assert.equal(db.calls.filter(
    (call) => call.table === 'custom_object_audit_event' && call.type === 'from',
  ).length, 1);
  await assert.rejects(
    () => createCustomObjectService({
      db,
      context: context(),
      canViewSchema: true,
    }).listAudit(objectId, { entityType: 'arbitrary_table' }),
    (error) => error.status === 400 && /audit entity type/.test(error.message),
  );
});

test('schema service authorization does not treat record admin status as schema access', async () => {
  const db = mockDb({ custom_object_definition: [object({ status: 'draft' })] });
  const service = createCustomObjectService({
    db,
    context: context(),
    isAdmin: true,
  });
  await assert.rejects(
    () => service.createField(objectId, {
      name: 'title', label: 'Title', field_type: 'text',
    }),
    (error) => error.status === 403 && /management access/.test(error.message),
  );
  await assert.rejects(
    () => service.listAudit(objectId, {}),
    (error) => error.status === 403 && /catalogue access/.test(error.message),
  );
});

test('view-only schema catalogue can include draft, active, and archived objects', async () => {
  const db = mockDb({
    custom_object_definition: [
      object({ id: 'draft', status: 'draft' }),
      object({ id: 'active', status: 'active' }),
      object({ id: 'archived', status: 'archived' }),
    ],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canViewSchema: true,
  });
  const normal = await service.listObjects({});
  assert.deepEqual(normal.data.map((row) => row.status).sort(), ['active', 'draft']);
  const includingArchived = await service.listObjects({ includeArchived: 'true' });
  assert.deepEqual(
    includingArchived.data.map((row) => row.status).sort(),
    ['active', 'archived', 'draft'],
  );
});

test('schema catalogue applies lifecycle status before count and pagination', async () => {
  const db = mockDb({
    custom_object_definition: [
      object({ id: 'draft-1', status: 'draft', created_at: '2026-03-01' }),
      object({ id: 'active-1', status: 'active', created_at: '2026-02-01' }),
      object({ id: 'active-2', status: 'active', created_at: '2026-01-01' }),
    ],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canViewSchema: true,
  });
  const result = await service.listObjects({
    status: 'active',
    page: '2',
    pageSize: '1',
  });
  assert.equal(result.total, 2);
  assert.equal(result.page, 2);
  assert.deepEqual(result.data.map((row) => row.id), ['active-2']);
  await assert.rejects(
    () => service.listObjects({ status: 'deleted' }),
    (error) => error.status === 400 && /status must be/.test(error.message),
  );
});

test('archived objects reject child schema and permission mutations', async () => {
  const relationshipId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object({ status: 'archived', archived_at: '2026-01-01' })],
    preference_field: [field()],
    custom_object_relationship_definition: [{
      id: relationshipId,
      tenant_id: tenantId,
      source_custom_object_id: objectId,
      target_custom_object_id: null,
    }],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canManageSchema: true,
  });
  const assertions = [
    () => service.createField(objectId, { name: 'title', label: 'Title', field_type: 'text' }),
    () => service.updateField(objectId, 'field-1', { label: 'Changed' }),
    () => service.updateField(objectId, 'field-1', {}, true),
    () => service.createRelationshipDefinition(objectId, {}),
    () => service.updateRelationshipDefinition(objectId, relationshipId, {}),
    () => service.updateRelationshipDefinition(objectId, relationshipId, {}, true),
    () => service.upsertPermission(objectId, { role_id: roleId }),
  ];
  for (const mutate of assertions) {
    await assert.rejects(
      mutate,
      (error) => error.status === 409 && /Archived Custom Objects/.test(error.message),
    );
  }
});

test('active primary display field cannot be deactivated', async () => {
  const db = mockDb({
    custom_object_definition: [object({ primary_display_field_id: 'field-1' })],
    preference_field: [field()],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canManageSchema: true,
  });
  await assert.rejects(
    () => service.updateField(objectId, 'field-1', {}, true),
    (error) => error.status === 409 && /primary display field/.test(error.message),
  );
  assert.equal(db.tables.preference_field[0].is_active, true);
});

test('object responses project only the current role effective record capabilities', async () => {
  const otherRoleId = '99999999-9999-4999-8999-999999999999';
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_create_records: true,
      can_edit_records: false,
      can_archive_records: true,
      can_export_records: false,
    }, {
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: otherRoleId,
      can_view_records: true,
      can_create_records: false,
      can_edit_records: true,
      can_archive_records: false,
      can_export_records: true,
    }],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canViewSchema: true,
  });
  const detail = await service.getObject(objectId);
  assert.deepEqual(detail.capabilities, {
    view: true, create: true, edit: false, archive: true, export: false,
  });
  const listed = await service.listObjects({});
  assert.deepEqual(listed.data[0].capabilities, detail.capabilities);
  assert.equal(Object.hasOwn(listed.data[0], 'role_id'), false);
  const permissionRoleLookups = db.calls.filter((call) =>
    call.table === 'custom_object_role_permission'
    && call.type === 'eq'
    && call.column === 'role_id');
  assert.ok(permissionRoleLookups.every((call) => call.value === roleId));
});

test('tenant administrators receive all projected record capabilities without role rows', async () => {
  const db = mockDb({ custom_object_definition: [object()] });
  const service = createCustomObjectService({
    db,
    context: context({ roleId: null }),
    isAdmin: true,
    canViewSchema: true,
  });
  assert.deepEqual((await service.getObject(objectId)).capabilities, {
    view: true, create: true, edit: true, archive: true, export: true,
  });
});

test('archived objects honor non-admin retrieval grants while disabling create and edit', async () => {
  const archivedObject = object({
    status: 'archived',
    archived_at: '2026-01-01T00:00:00.000Z',
  });
  const db = mockDb({
    custom_object_definition: [archivedObject],
    preference_field: [field({ is_required: false })],
    custom_object_record: [{
      id: 'record-1',
      tenant_id: tenantId,
      custom_object_id: objectId,
      data: { headcount: 12, historic_value: 'preserved' },
      archived_at: null,
    }],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_create_records: true,
      can_edit_records: true,
      can_archive_records: true,
      can_export_records: true,
    }],
  });
  const service = createCustomObjectService({ db, context: context() });
  const detail = await service.getObject(objectId);
  assert.deepEqual(detail.capabilities, {
    view: true,
    create: false,
    edit: false,
    archive: true,
    export: true,
  });
  const records = await service.listRecords(objectId, {});
  assert.equal(records.total, 1);
  assert.deepEqual(records.data[0].data, {
    headcount: 12,
    historic_value: 'preserved',
  });
});

test('record-only catalogue can discover granted archived objects but never drafts', async () => {
  const draftId = '44444444-4444-4444-8444-444444444444';
  const db = mockDb({
    custom_object_definition: [
      object({ status: 'archived', archived_at: '2026-01-01T00:00:00.000Z' }),
      object({ id: draftId, object_key: 'draft_object', status: 'draft' }),
    ],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_archive_records: true,
    }, {
      tenant_id: tenantId,
      custom_object_id: draftId,
      role_id: roleId,
      can_view_records: true,
    }],
  });
  const service = createCustomObjectService({ db, context: context() });
  assert.deepEqual((await service.listObjects({})).data, []);
  const result = await service.listObjects({ includeArchived: 'true' });
  assert.deepEqual(result.data.map((row) => row.id), [objectId]);
  assert.deepEqual(result.data[0].capabilities, {
    view: true,
    create: false,
    edit: false,
    archive: true,
    export: false,
  });
});

test('tenant admin archived projection keeps retrieval bypass but disables create and edit', async () => {
  const db = mockDb({
    custom_object_definition: [object({
      status: 'archived',
      archived_at: '2026-01-01T00:00:00.000Z',
    })],
  });
  const detail = await createCustomObjectService({
    db,
    context: context({ roleId: null }),
    isAdmin: true,
    canViewSchema: true,
  }).getObject(objectId);
  assert.deepEqual(detail.capabilities, {
    view: true,
    create: false,
    edit: false,
    archive: true,
    export: true,
  });
});

test('record writes explicitly reject draft or archived object lifecycles even for admins', async () => {
  for (const status of ['draft', 'archived']) {
    const db = mockDb({
      custom_object_definition: [object({ status })],
      custom_object_record: [{
        id: 'record-1', tenant_id: tenantId, custom_object_id: objectId,
        data: { headcount: 1 }, archived_at: null,
      }],
      preference_field: [field()],
    });
    const service = createCustomObjectService({ db, context: context(), isAdmin: true });
    await assert.rejects(
      () => service.createRecord(objectId, { data: { headcount: 2 } }),
      (error) => error.status === 409 && /active Custom Objects/.test(error.message),
    );
    await assert.rejects(
      () => service.updateRecord(objectId, 'record-1', { data: { headcount: 2 } }),
      (error) => error.status === 409 && /active Custom Objects/.test(error.message),
    );
  }
});

test('record listing applies typed metadata filters, exact filtered count, and stable field sorting', async () => {
  const sortable = field({ id: '44444444-4444-4444-8444-444444444444' });
  const records = [
    { id: 'b', tenant_id: tenantId, custom_object_id: objectId, data: { headcount: 20, historic: 'kept' }, archived_at: null },
    { id: 'a', tenant_id: tenantId, custom_object_id: objectId, data: { headcount: 20 }, archived_at: null },
    { id: 'c', tenant_id: tenantId, custom_object_id: objectId, data: { headcount: 5 }, archived_at: null },
  ];
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [sortable],
    custom_object_record: records,
  });
  const result = await createCustomObjectService({
    db, context: context(), isAdmin: true,
  }).listRecords(objectId, {
    page: '1',
    pageSize: '1',
    sortField: sortable.id,
    sortDir: 'asc',
    filters: JSON.stringify({ [sortable.id]: { op: 'gte', value: '20' } }),
  });
  assert.equal(result.total, 2);
  assert.equal(result.data[0].id, 'a');
  assert.equal(result.data[0].data.headcount, 20);
  const orders = db.calls.filter((call) => call.table === 'custom_object_record' && call.type === 'order');
  assert.deepEqual(orders.map((call) => call.column), ['data->headcount', 'id']);
  assert.ok(db.calls.some((call) =>
    call.type === 'filter' && call.column === 'data->headcount' && call.operator === 'gte'));
});

test('record search uses only active searchable metadata and rejects unwhitelisted fields/operators', async () => {
  const title = field({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'title',
    label: 'Title',
    field_type: 'text',
    is_required: false,
  });
  const archived = field({
    id: '55555555-5555-4555-8555-555555555555',
    name: 'secret',
    field_type: 'text',
    is_active: false,
  });
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [title, archived],
    custom_object_record: [],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  await service.listRecords(objectId, { search: 'quoted",unsafe', pageSize: '25' });
  const searchCall = db.calls.find((call) =>
    call.table === 'custom_object_record' && call.type === 'or');
  assert.match(searchCall.expression, /^data->>title\.ilike\./);
  assert.doesNotMatch(searchCall.expression, /secret/);

  await assert.rejects(
    () => service.listRecords(objectId, {
      filters: JSON.stringify({ [archived.id]: { op: 'contains', value: 'x' } }),
    }),
    (error) => error.status === 400 && /Unknown or inactive/.test(error.message),
  );
  await assert.rejects(
    () => service.listRecords(objectId, {
      filters: JSON.stringify({ [title.id]: { op: 'gte', value: 'x' } }),
    }),
    (error) => error.status === 400 && /not supported/.test(error.message),
  );
});

test('is_not_empty uses explicit non-null and non-empty predicates', async () => {
  const title = field({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'title',
    label: 'Title',
    field_type: 'text',
    is_required: false,
  });
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [title],
    custom_object_record: [
      { id: 'null', tenant_id: tenantId, custom_object_id: objectId, data: { title: null }, archived_at: null },
      { id: 'empty', tenant_id: tenantId, custom_object_id: objectId, data: { title: '' }, archived_at: null },
      { id: 'missing', tenant_id: tenantId, custom_object_id: objectId, data: {}, archived_at: null },
      { id: 'value', tenant_id: tenantId, custom_object_id: objectId, data: { title: 'Present' }, archived_at: null },
    ],
  });
  const result = await createCustomObjectService({
    db, context: context(), isAdmin: true,
  }).listRecords(objectId, {
    filters: JSON.stringify({ [title.id]: { op: 'is_not_empty' } }),
  });
  assert.deepEqual(result.data.map((record) => record.id), ['value']);
  assert.ok(db.calls.some((call) =>
    call.type === 'not'
    && call.column === 'data->>title'
    && call.operator === 'is'
    && call.value === null));
  assert.ok(db.calls.some((call) =>
    call.type === 'neq' && call.column === 'data->>title' && call.value === ''));
  assert.equal(db.calls.some((call) =>
    call.type === 'not' && call.operator === 'in'), false);
});

test('permission listing includes every tenant role and never returns another tenant role', async () => {
  const db = mockDb({
    custom_object_definition: [object()],
    role: [
      { id: 'role-z', tenant_id: tenantId, name: 'Zeta', label: 'Zeta role', is_system: false },
      { id: 'role-a', tenant_id: tenantId, name: 'Alpha', label: 'Alpha role', is_system: true },
      { id: 'foreign-role', tenant_id: 'other-tenant', name: 'Foreign', is_system: false },
    ],
    custom_object_role_permission: [
      {
        id: 'permission-1',
        tenant_id: tenantId,
        custom_object_id: objectId,
        role_id: 'role-a',
        can_view_records: true,
      },
      {
        id: 'foreign-permission',
        tenant_id: 'other-tenant',
        custom_object_id: objectId,
        role_id: 'foreign-role',
        can_view_records: true,
      },
    ],
  });
  const result = await createCustomObjectService({
    db,
    context: context(),
    canViewSchema: true,
  }).listPermissions(objectId, { page: '1', pageSize: '1' });
  assert.deepEqual(result.data.map((permission) => permission.id), ['permission-1']);
  assert.equal(result.total, 1);
  assert.deepEqual(result.roles.map((role) => role.id), ['role-a', 'role-z']);
  assert.ok(db.calls.some((call) =>
    call.table === 'role'
    && call.type === 'eq'
    && call.column === 'tenant_id'
    && call.value === tenantId));
});

test('permission upserts require view for every dependent record capability', async () => {
  const db = mockDb({
    custom_object_definition: [object()],
    role: [{ id: roleId, tenant_id: tenantId, name: 'Member' }],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    canManageSchema: true,
  });
  for (const capability of [
    'can_create_records',
    'can_edit_records',
    'can_archive_records',
    'can_export_records',
  ]) {
    await assert.rejects(
      () => service.upsertPermission(objectId, {
        role_id: roleId,
        can_view_records: false,
        [capability]: true,
      }),
      (error) => error.status === 400 && /View records permission is required/.test(error.message),
      capability,
    );
  }
  await assert.rejects(
    () => service.upsertPermission(objectId, {
      role_id: roleId,
      can_view_records: 'true',
    }),
    (error) => error.status === 400 && /must be a boolean/.test(error.message),
  );

  const granted = await service.upsertPermission(objectId, {
    role_id: roleId,
    can_view_records: true,
    can_create_records: true,
  });
  assert.equal(granted.can_view_records, true);
  assert.equal(granted.can_create_records, true);
  assert.equal(granted.can_edit_records, false);

  await assert.rejects(
    () => service.upsertPermission(objectId, {
      role_id: roleId,
      can_view_records: false,
    }),
    (error) => error.status === 400 && /View records permission is required/.test(error.message),
  );
  const revoked = await service.upsertPermission(objectId, {
    role_id: roleId,
    can_view_records: false,
    can_create_records: false,
  });
  assert.equal(revoked.can_view_records, false);
  assert.equal(revoked.can_create_records, false);
});

test('relationship definitions validate endpoint ownership and preserve immutable topology', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetObjectId, object_key: 'locations' }),
    ],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      relationship_key: 'department_location',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetObjectId,
      cardinality: 'many_to_many',
      source_label: 'Locations',
      target_label: 'Departments',
      is_required: false,
      show_on_source: true,
      show_on_target: true,
      edit_from_source: true,
      edit_from_target: true,
      status: 'active',
      configuration: {},
    }],
  });
  const service = createCustomObjectService({
    db, context: context(), canManageSchema: true,
  });
  await assert.rejects(
    () => service.createRelationshipDefinition(objectId, {
      relationship_key: 'invalid key',
      source_kind: 'custom_object',
      target_kind: 'member',
      cardinality: 'many_to_many',
      source_label: 'Members',
      target_label: 'Departments',
    }),
    (error) => error.status === 400 && /Invalid relationship definition/.test(error.message),
  );
  await assert.rejects(
    () => service.updateRelationshipDefinition(objectId, definitionId, {
      cardinality: 'one_to_one',
    }),
    (error) => error.status === 409 && /cannot be changed/.test(error.message),
  );
  const updated = await service.updateRelationshipDefinition(objectId, definitionId, {
    target_label: 'Teams',
  });
  assert.equal(updated.target_label, 'Teams');
});

test('entity picker paginates and projects stable labels for every endpoint shape', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_record: [{
      id: 'record-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null,
    }, {
      id: 'wrong-record', tenant_id: tenantId, custom_object_id: 'other-object', archived_at: null,
    }],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'member',
      target_custom_object_id: null,
      show_on_source: true,
      edit_from_source: true,
    }],
    member: [
      { id: 'member-b', tenant_id: tenantId, first_name: 'Bea', last_name: 'Zulu', email: 'bea@example.com' },
      { id: 'member-a', tenant_id: tenantId, first_name: 'Ada', last_name: 'Alpha', email: 'ada@example.com' },
      { id: 'foreign', tenant_id: 'other-tenant', first_name: 'Foreign', last_name: 'Member' },
    ],
  });
  const result = await createCustomObjectService({
    db, context: context(), isAdmin: true,
  }).entityPicker(objectId, {
    definitionId, recordId: 'record-1', side: 'source', page: '1', pageSize: '1',
  });
  assert.deepEqual(result, {
    data: [{
      id: 'member-a',
      kind: 'member',
      custom_object_id: null,
      primary_label: 'Ada Alpha',
      secondary_text: 'ada@example.com',
    }],
    page: 1,
    pageSize: 1,
    total: 2,
  });
});

test('record-scoped related query supports reverse display and resolves one level only', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_record: [{
      id: 'department-1',
      tenant_id: tenantId,
      custom_object_id: objectId,
      archived_at: null,
    }],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'member',
      source_custom_object_id: null,
      target_kind: 'custom_object',
      target_custom_object_id: objectId,
      show_on_target: true,
    }],
    custom_object_relationship: [{
      id: 'edge-1',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'member-1',
      target_record_id: 'department-1',
      archived_at: null,
      created_at: '2026-01-01',
    }],
    member: [{
      id: 'member-1',
      tenant_id: tenantId,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
    }],
  });
  const result = await createCustomObjectService({
    db, context: context(), isAdmin: true,
  }).listRelationships(objectId, {
    definitionId,
    recordId: 'department-1',
    side: 'target',
  });
  assert.equal(result.total, 1);
  assert.deepEqual(result.data[0].related, {
    id: 'member-1',
    kind: 'member',
    custom_object_id: null,
    primary_label: 'Ada Lovelace',
    secondary_text: 'ada@example.com',
  });
  assert.equal(Object.hasOwn(result.data[0].related, 'relationships'), false);
});

test('archived edges remain listable when their related custom record and object are archived', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({
        id: targetObjectId,
        object_key: 'locations',
        status: 'archived',
        archived_at: '2026-01-02T00:00:00.000Z',
      }),
    ],
    preference_field: [field({ is_required: false })],
    custom_object_record: [{
      id: 'source-1',
      tenant_id: tenantId,
      custom_object_id: objectId,
      data: {},
      archived_at: null,
    }, {
      id: 'target-1',
      tenant_id: tenantId,
      custom_object_id: targetObjectId,
      data: {},
      archived_at: '2026-01-02T00:00:00.000Z',
    }],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'archived',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetObjectId,
      show_on_source: true,
    }],
    custom_object_relationship: [{
      id: 'edge-1',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'target-1',
      archived_at: '2026-01-02T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    }],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
    }, {
      tenant_id: tenantId,
      custom_object_id: targetObjectId,
      role_id: roleId,
      can_view_records: true,
    }],
  });
  const service = createCustomObjectService({ db, context: context() });
  const result = await service.listRelationships(objectId, {
    definitionId,
    recordId: 'source-1',
    side: 'source',
    includeArchived: 'true',
  });
  assert.equal(result.total, 1);
  assert.equal(result.data[0].archived_at, '2026-01-02T00:00:00.000Z');
  assert.equal(result.data[0].related.archived_at, '2026-01-02T00:00:00.000Z');
  assert.equal(result.data[0].related.custom_object_status, 'archived');
});

test('edge mutation requires an explicit routed side and matching routed record', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'member',
      target_custom_object_id: null,
      edit_from_source: true,
    }],
    custom_object_record: [{
      id: 'department-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null,
    }],
    member: [{ id: 'member-1', tenant_id: tenantId }],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  await assert.rejects(
    () => service.createRelationship(objectId, {
      relationship_definition_id: definitionId,
      source_record_id: 'department-1',
      target_record_id: 'member-1',
    }),
    (error) => error.status === 400 && /routed_side/.test(error.message),
  );
  await assert.rejects(
    () => service.createRelationship(objectId, {
      relationship_definition_id: definitionId,
      source_record_id: 'department-1',
      target_record_id: 'member-1',
      routed_side: 'source',
      routed_record_id: 'another-record',
    }),
    (error) => error.status === 400 && /routed_record_id/.test(error.message),
  );
});

test('archived definitions remain reviewable after their routed endpoint object archives', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object({
      status: 'archived',
      archived_at: '2026-01-01T00:00:00.000Z',
    })],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'member',
      target_custom_object_id: null,
      status: 'archived',
      archived_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    }],
  });
  const result = await createCustomObjectService({
    db, context: context(), canViewSchema: true,
  }).listRelationshipDefinitions(objectId, { includeArchived: 'true' });
  assert.deepEqual(result.data.map((definition) => definition.id), [definitionId]);
  const activeResult = await createCustomObjectService({
    db, context: context(), canViewSchema: true,
  }).listRelationshipDefinitions(objectId, {});
  assert.deepEqual(activeResult.data, []);
});

test('active relationship definitions reject archived Custom Object endpoints during listing', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({
        id: targetObjectId,
        object_key: 'archived_target',
        status: 'archived',
        archived_at: '2026-01-01T00:00:00.000Z',
      }),
    ],
    custom_object_relationship_definition: [{
      id: 'definition-1',
      tenant_id: tenantId,
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetObjectId,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    }],
  });
  await assert.rejects(
    () => createCustomObjectService({
      db, context: context(), canViewSchema: true,
    }).listRelationshipDefinitions(objectId, {}),
    (error) => error.status === 409 && /endpoint is unavailable/.test(error.message),
  );
});

test('database cardinality and required-edge guards map to HTTP 409 conflicts', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const baseSeed = {
    custom_object_definition: [object()],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'one_to_one',
      is_required: true,
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: objectId,
      edit_from_source: true,
    }],
    custom_object_record: [
      { id: 'source-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null },
      { id: 'target-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null },
    ],
  };
  const cardinalityDb = mockDb(baseSeed);
  const cardinalityFrom = cardinalityDb.from.bind(cardinalityDb);
  cardinalityDb.from = (table) => {
    if (table !== 'custom_object_relationship') return cardinalityFrom(table);
    return {
      insert() { return this; },
      select() { return this; },
      async single() {
        return {
          data: null,
          error: {
            code: '23505',
            constraint: 'custom_object_relationship_source_cardinality',
            message: 'Source record exceeds relationship cardinality',
          },
        };
      },
    };
  };
  await assert.rejects(
    () => createCustomObjectService({
      db: cardinalityDb, context: context(), isAdmin: true,
    }).createRelationship(objectId, {
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'target-1',
      routed_side: 'source',
      routed_record_id: 'source-1',
    }),
    (error) => error.status === 409 && /cardinality/.test(error.message),
  );

  const requiredDb = mockDb({
    ...baseSeed,
    custom_object_relationship: [{
      id: 'edge-1',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'target-1',
      archived_at: null,
    }],
  });
  requiredDb.rpc = () => {
    return {
      async single() {
        return {
          data: null,
          error: {
            code: '23514',
            constraint: 'custom_object_relationship_required_source',
            message: 'A required relationship cannot lose its final active edge',
          },
        };
      },
    };
  };
  await assert.rejects(
    () => createCustomObjectService({
      db: requiredDb, context: context(), isAdmin: true,
    }).archiveRelationship(objectId, 'edge-1', {
      routed_side: 'source',
      routed_record_id: 'source-1',
    }),
    (error) => error.status === 409 && /required relationship/.test(error.message),
  );
});

test('definition-bound picker rejects arbitrary, hidden, mismatched, and non-admin core access', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const definition = {
    id: definitionId,
    tenant_id: tenantId,
    status: 'active',
    source_kind: 'custom_object',
    source_custom_object_id: objectId,
    target_kind: 'member',
    target_custom_object_id: null,
    show_on_source: true,
    edit_from_source: true,
  };
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_record: [{
      id: 'record-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null,
    }, {
      id: 'wrong-record', tenant_id: tenantId, custom_object_id: 'other-object', archived_at: null,
    }],
    custom_object_relationship_definition: [definition],
    member: [{ id: 'member-1', tenant_id: tenantId, email: 'private@example.com' }],
  });
  const adminService = createCustomObjectService({ db, context: context(), isAdmin: true });
  await assert.rejects(
    () => adminService.entityPicker(objectId, { kind: 'member', customObjectId: 'forged' }),
    (error) => error.status === 400 && /derived/.test(error.message),
  );
  await assert.rejects(
    () => adminService.entityPicker(objectId, {
      definitionId, recordId: 'record-1', side: 'target',
    }),
    (error) => error.status === 400 && /Routed side/.test(error.message),
  );
  await assert.rejects(
    () => adminService.entityPicker(objectId, {
      definitionId, recordId: 'wrong-record', side: 'source',
    }),
    (error) => error.status === 404,
  );
  db.tables.custom_object_relationship_definition[0].show_on_source = false;
  await assert.rejects(
    () => adminService.entityPicker(objectId, {
      definitionId, recordId: 'record-1', side: 'source',
    }),
    (error) => error.status === 403 && /hidden/.test(error.message),
  );
  db.tables.custom_object_relationship_definition[0].show_on_source = true;
  db.tables.custom_object_relationship_definition[0].edit_from_source = false;
  await assert.rejects(
    () => adminService.entityPicker(objectId, {
      definitionId, recordId: 'record-1', side: 'source',
    }),
    (error) => error.status === 403 && /cannot be edited/.test(error.message),
  );
  db.tables.custom_object_relationship_definition[0].edit_from_source = true;
  await assert.rejects(
    () => createCustomObjectService({
      db, context: context(), isAdmin: false,
    }).entityPicker(objectId, {
      definitionId, recordId: 'record-1', side: 'source',
    }),
    (error) => error.status === 403 && /administrator/.test(error.message),
  );
});

test('non-admin record APIs cannot enumerate or mutate core-endpoint relationships', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_record: [{
      id: 'record-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null,
    }],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'member',
      target_custom_object_id: null,
      show_on_source: true,
      edit_from_source: true,
      created_at: '2026-01-01',
    }],
    member: [{ id: 'member-1', tenant_id: tenantId }],
    custom_object_relationship: [{
      id: 'edge-1',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'record-1',
      target_record_id: 'member-1',
      archived_at: null,
    }],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_edit_records: true,
    }],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: false });
  assert.deepEqual((await service.listRelationshipDefinitions(objectId, {})).data, []);
  await assert.rejects(
    () => service.listRelationships(objectId, {
      definitionId, recordId: 'record-1', side: 'source',
    }),
    (error) => error.status === 403 && /administrator/.test(error.message),
  );
  await assert.rejects(
    () => service.createRelationship(objectId, {
      relationship_definition_id: definitionId,
      source_record_id: 'record-1',
      target_record_id: 'member-1',
      routed_side: 'source',
      routed_record_id: 'record-1',
    }),
    (error) => error.status === 403 && /administrator/.test(error.message),
  );
  await assert.rejects(
    () => service.archiveRelationship(objectId, 'edge-1', {
      routed_side: 'source', routed_record_id: 'record-1',
    }),
    (error) => error.status === 403 && /administrator/.test(error.message),
  );
});

test('non-admin relationship definition visibility is filtered before pagination and count', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const hiddenObjectId = '66666666-6666-4666-8666-666666666666';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetObjectId, object_key: 'locations' }),
      object({ id: hiddenObjectId, object_key: 'hidden' }),
    ],
    custom_object_relationship_definition: [{
      id: 'newest-core',
      tenant_id: tenantId,
      status: 'active',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'member',
      target_custom_object_id: null,
      created_at: '2026-03-01',
    }, {
      id: 'hidden-custom',
      tenant_id: tenantId,
      status: 'active',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: hiddenObjectId,
      created_at: '2026-02-01',
    }, {
      id: 'visible-custom',
      tenant_id: tenantId,
      status: 'active',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetObjectId,
      created_at: '2026-01-01',
    }],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
    }, {
      tenant_id: tenantId,
      custom_object_id: targetObjectId,
      role_id: roleId,
      can_view_records: true,
    }],
  });
  const result = await createCustomObjectService({
    db,
    context: context(),
  }).listRelationshipDefinitions(objectId, { page: '1', pageSize: '1' });
  assert.deepEqual(result.data.map((definition) => definition.id), ['visible-custom']);
  assert.equal(result.total, 1);
  const rangeIndex = db.calls.findIndex((call) =>
    call.table === 'custom_object_relationship_definition' && call.type === 'from');
  assert.ok(db.calls.slice(rangeIndex).some((call) =>
    call.table === 'custom_object_relationship_definition'
    && call.type === 'eq'
    && call.column === 'source_kind'
    && call.value === 'custom_object'));
});

test('core relationship discovery is generic across all core kinds and hides inactive or one-sided definitions', async () => {
  const coreKinds = ['member', 'organization', 'organization_group'];
  const coreTables = Object.fromEntries(coreKinds.map((kind) => [
    kind,
    [{ id: `${kind}-1`, tenant_id: tenantId, name: `${kind} one` }],
  ]));
  const definitions = coreKinds.map((kind, index) => ({
    id: `definition-${index}`,
    tenant_id: tenantId,
    relationship_key: `${kind}_departments`,
    status: 'active',
    source_kind: kind,
    source_custom_object_id: null,
    target_kind: 'custom_object',
    target_custom_object_id: objectId,
    source_label: 'Departments',
    target_label: kind,
    cardinality: 'many_to_many',
    show_on_source: true,
    edit_from_source: index !== 1,
    created_at: `2026-01-0${index + 1}`,
  }));
  const db = mockDb({
    ...coreTables,
    custom_object_definition: [object({
      singular_label: 'Department',
      plural_label: 'Departments',
      primary_display_field_id: 'field-name',
    })],
    preference_field: [field({
      id: 'field-name',
      name: 'name',
      label: 'Name',
      field_type: 'text',
      is_required: false,
    })],
    custom_object_relationship_definition: [
      ...definitions,
      { ...definitions[0], id: 'draft', relationship_key: 'draft', status: 'draft' },
      { ...definitions[0], id: 'hidden', relationship_key: 'hidden', show_on_source: false },
      { ...definitions[0], id: 'foreign', relationship_key: 'foreign', tenant_id: 'other-tenant' },
    ],
    custom_object_relationship: coreKinds.map((kind, index) => ({
      id: `edge-${index}`,
      tenant_id: tenantId,
      relationship_definition_id: `definition-${index}`,
      source_record_id: `${kind}-1`,
      target_record_id: `department-${index}`,
      archived_at: null,
    })),
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  for (let index = 0; index < coreKinds.length; index += 1) {
    const kind = coreKinds[index];
    const result = await service.listCoreRelationshipDefinitions(kind, `${kind}-1`);
    assert.equal(result.data.length, 1);
    assert.deepEqual(result.data[0], {
      definition: {
        id: `definition-${index}`,
        relationship_key: `${kind}_departments`,
        status: 'active',
        source_kind: kind,
        source_custom_object_id: null,
        target_kind: 'custom_object',
        target_custom_object_id: objectId,
        source_label: 'Departments',
        target_label: kind,
        cardinality: 'many_to_many',
        show_on_source: true,
        show_on_target: undefined,
        edit_from_source: index !== 1,
        edit_from_target: undefined,
      },
      side: 'source',
      label: 'Departments',
      related_object: {
        id: objectId,
        object_key: 'departments',
        singular_label: 'Department',
        plural_label: 'Departments',
      },
      count: 1,
      can_edit: index !== 1,
    });
  }
  db.tables.custom_object_relationship_definition.length = 0;
  assert.deepEqual(
    await service.listCoreRelationshipDefinitions('member', 'member-1'),
    { data: [] },
  );
});

test('core relationship rows use primary labels, paginate, enforce edit flags, permissions, and tenant isolation', async () => {
  const definitionId = 'core-definition';
  const db = mockDb({
    member: [
      { id: 'member-1', tenant_id: tenantId, first_name: 'Ada' },
      { id: 'foreign-member', tenant_id: 'other-tenant' },
    ],
    custom_object_definition: [object({
      singular_label: 'Qualification',
      plural_label: 'Qualifications',
      primary_display_field_id: 'field-name',
    })],
    preference_field: [field({
      id: 'field-name', name: 'name', field_type: 'text', is_required: false,
    })],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      source_kind: 'member',
      source_custom_object_id: null,
      target_kind: 'custom_object',
      target_custom_object_id: objectId,
      show_on_source: true,
      edit_from_source: true,
      cardinality: 'many_to_many',
    }],
    custom_object_record: [{
      id: 'qualification-1',
      tenant_id: tenantId,
      custom_object_id: objectId,
      data: { name: 'First Aid' },
      archived_at: null,
      created_at: '2026-01-01',
    }, {
      id: 'qualification-2',
      tenant_id: tenantId,
      custom_object_id: objectId,
      data: { name: 'Governance' },
      archived_at: null,
      created_at: '2026-01-02',
    }, {
      id: 'foreign-qualification',
      tenant_id: 'other-tenant',
      custom_object_id: objectId,
      data: { name: 'Private' },
      archived_at: null,
    }],
    custom_object_relationship: [{
      id: 'edge-1',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'member-1',
      target_record_id: 'qualification-1',
      archived_at: null,
      created_at: '2026-01-01',
    }, {
      id: 'edge-2',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'member-1',
      target_record_id: 'qualification-2',
      archived_at: null,
      created_at: '2026-01-02',
    }, {
      id: 'foreign-edge',
      tenant_id: 'other-tenant',
      relationship_definition_id: definitionId,
      source_record_id: 'member-1',
      target_record_id: 'foreign-qualification',
      archived_at: null,
    }],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  const page = await service.listCoreRelationships('member', 'member-1', {
    definitionId, page: '2', pageSize: '1',
  });
  assert.equal(page.total, 2);
  assert.equal(page.page, 2);
  assert.equal(page.data[0].related.primary_label, 'First Aid');
  const picker = await service.coreEntityPicker('member', 'member-1', {
    definitionId, page: '1', pageSize: '1',
  });
  assert.equal(picker.total, 2);
  assert.equal(picker.data[0].primary_label, 'First Aid');
  await assert.rejects(
    () => service.listCoreRelationshipDefinitions('member', 'foreign-member'),
    (error) => error.status === 404,
  );
  db.tables.custom_object_relationship_definition[0].edit_from_source = false;
  await assert.rejects(
    () => service.coreEntityPicker('member', 'member-1', { definitionId }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    () => createCustomObjectService({ db, context: context(), isAdmin: false })
      .listCoreRelationshipDefinitions('member', 'member-1'),
    (error) => error.status === 403 && /administrator/.test(error.message),
  );
});

test('Department-member pickers are constrained to the Department organisation only', async () => {
  const departmentObjectId = objectId;
  const memberDefinitionId = 'department-members';
  const parentDefinitionId = 'department-organisation';
  const seed = {
    custom_object_definition: [object({ id: departmentObjectId, object_key: 'org_department' })],
    preference_field: [field({ custom_object_id: departmentObjectId, name: 'name', field_type: 'text' })],
    custom_object_relationship_definition: [{
      id: memberDefinitionId, tenant_id: tenantId, relationship_key: 'members', status: 'active',
      source_kind: 'custom_object', source_custom_object_id: departmentObjectId,
      target_kind: 'member', target_custom_object_id: null, cardinality: 'one_to_many',
      configuration: { picker_scope: { via_relationship_key: 'organisation', routed_core_field: 'organization_id' } },
      show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
    }, {
      id: parentDefinitionId, tenant_id: tenantId, relationship_key: 'organisation', status: 'active',
      is_required: true, source_kind: 'custom_object', source_custom_object_id: departmentObjectId,
      target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one',
    }],
    custom_object_record: [
      { id: 'dept-a', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, data: { name: 'A' } },
      { id: 'dept-b', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, data: { name: 'B' } },
    ],
    member: [
      { id: 'member-a', tenant_id: tenantId, organization_id: 'org-a', first_name: 'A', last_name: 'Member' },
      { id: 'member-b', tenant_id: tenantId, organization_id: 'org-b', first_name: 'B', last_name: 'Member' },
    ],
    custom_object_relationship: [
      { id: 'parent-a', tenant_id: tenantId, relationship_definition_id: parentDefinitionId, source_record_id: 'dept-a', target_record_id: 'org-a', archived_at: null },
      { id: 'parent-b', tenant_id: tenantId, relationship_definition_id: parentDefinitionId, source_record_id: 'dept-b', target_record_id: 'org-b', archived_at: null },
    ],
  };
  const service = createCustomObjectService({ db: mockDb(seed), context: context(), isAdmin: true });
  const fromMember = await service.coreEntityPicker('member', 'member-a', { definitionId: memberDefinitionId });
  assert.deepEqual(fromMember.data.map(row => row.id), ['dept-a']);
  const fromDepartment = await service.entityPicker(departmentObjectId, {
    definitionId: memberDefinitionId, recordId: 'dept-a', side: 'source',
  });
  assert.deepEqual(fromDepartment.data.map(row => row.id), ['member-a']);
});

test('unrelated relationship pickers retain generic candidates, including a non-Department members key', async () => {
  const definitionId = 'generic-members';
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [field({ field_type: 'text' })],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, relationship_key: 'members', status: 'active',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'member', target_custom_object_id: null, cardinality: 'one_to_many',
      show_on_source: true, edit_from_source: true,
    }],
    custom_object_record: [{ id: 'record-a', tenant_id: tenantId, custom_object_id: objectId, archived_at: null }],
    member: [
      { id: 'member-a', tenant_id: tenantId, organization_id: 'org-a', first_name: 'A' },
      { id: 'member-b', tenant_id: tenantId, organization_id: 'org-b', first_name: 'B' },
    ],
  });
  const picker = await createCustomObjectService({ db, context: context(), isAdmin: true }).entityPicker(objectId, {
    definitionId, recordId: 'record-a', side: 'source',
  });
  assert.deepEqual(picker.data.map(row => row.id).sort(), ['member-a', 'member-b']);
});