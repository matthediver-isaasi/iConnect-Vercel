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

    select(columns, options = {}) {
      this.wantCount = options.count === 'exact';
      calls.push({ table: this.table, type: 'select', columns });
      return this;
    }
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
      } else if (operator === 'in') {
        const excluded = value.slice(1, -1).split(',').map((item) => JSON.parse(item));
        this.filters.push((row) => !excluded.includes(this.value(row, column)));
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
    range(from, to) {
      this.slice = [from, to + 1];
      calls.push({ table: this.table, type: 'range', from, to });
      return this;
    }
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
        if (name === 'custom_object_record_relationship_projection') {
          const rows = [];
          const endpointFor = (item, id) => {
            const table = {
              custom_object: 'custom_object_record',
              member: 'member',
              organization: 'organization',
              organization_group: 'organization_group',
            }[item.endpoint_kind];
            return (tables[table] || []).find((endpoint) =>
              endpoint.id === id
              && endpoint.tenant_id === args.p_tenant_id
              && (item.endpoint_kind !== 'custom_object'
                || (
                  endpoint.custom_object_id === item.endpoint_custom_object_id
                  && endpoint.archived_at == null
                )));
          };
          const labelFor = (item, endpoint) => {
            if (item.endpoint_kind === 'member') {
              return [endpoint.first_name, endpoint.last_name].filter(Boolean).join(' ').trim()
                || endpoint.email || endpoint.id;
            }
            if (item.endpoint_kind === 'custom_object') {
              return String(endpoint.data?.[item.display_key] ?? endpoint.id);
            }
            return endpoint.name || endpoint.id;
          };
          for (const item of args.p_items || []) {
            const routedColumn = item.side === 'source' ? 'source_record_id' : 'target_record_id';
            const oppositeColumn = item.side === 'source' ? 'target_record_id' : 'source_record_id';
            for (const recordId of args.p_record_ids || []) {
              const matches = (tables.custom_object_relationship || [])
                .filter((edge) =>
                  edge.tenant_id === args.p_tenant_id
                  && edge.archived_at == null
                  && edge.relationship_definition_id === item.relationship_definition_id
                  && edge[routedColumn] === recordId)
                .map((edge) => ({
                  edge,
                  endpoint: endpointFor(item, edge[oppositeColumn]),
                }))
                .filter(({ endpoint }) => Boolean(endpoint))
                .sort((left, right) =>
                  labelFor(item, left.endpoint).localeCompare(labelFor(item, right.endpoint))
                  || String(left.edge[oppositeColumn]).localeCompare(String(right.edge[oppositeColumn])));
              for (const match of matches.slice(0, args.p_label_limit)) {
                rows.push({
                  list_field_id: item.list_field_id,
                  routed_record_id: recordId,
                  opposite_record_id: match.edge[oppositeColumn],
                  total_count: matches.length,
                });
              }
            }
          }
          return { data: rows, error: null };
        }
        if (name === 'create_custom_object_record_with_relationships') {
          const record = {
            id: `custom_object_record-${(tables.custom_object_record || []).length + 1}`,
            tenant_id: args.p_tenant_id,
            custom_object_id: args.p_custom_object_id,
            data: structuredClone(args.p_data),
            created_by: args.p_created_by,
            updated_by: args.p_created_by,
          };
          return { data: { record, relationships: [] }, error: null };
        }
        if (name === 'custom_object_record_relationship_list') {
          let rows = (tables.custom_object_record || []).filter((row) =>
            row.tenant_id === args.p_tenant_id
            && row.custom_object_id === args.p_custom_object_id
            && (args.p_include_archived || row.archived_at == null));
          const scalar = args.p_scalar_plan || {};
          const scalarKey = (filter) =>
            String(filter.textColumn || filter.column || '').match(/([a-z][a-z0-9_]*)$/)?.[1];
          for (const filter of scalar.filters || []) {
            const key = scalarKey(filter);
            rows = rows.filter((row) => {
              const value = row.data?.[key];
              if (filter.kind === 'is_empty') return value == null || value === '';
              if (filter.kind === 'is_not_empty') return value != null && value !== '';
              if (filter.kind === 'any_of_scalar') return filter.values.map(String).includes(String(value));
              if (filter.kind === 'none_of_scalar') return !filter.values.map(String).includes(String(value));
              if (filter.kind === 'any_of_array') {
                return Array.isArray(value) && filter.values.some((candidate) => value.includes(candidate));
              }
              if (filter.kind === 'none_of_array') {
                return !Array.isArray(value) || !filter.values.some((candidate) => value.includes(candidate));
              }
              if (filter.kind !== 'filter') return false;
              if (filter.op === 'ilike') {
                const needle = String(filter.value).replaceAll('*', '').toLocaleLowerCase();
                return String(value ?? '').toLocaleLowerCase().includes(needle);
              }
              const target = String(filter.column).includes('->>')
                ? filter.value
                : JSON.parse(filter.value);
              if (filter.op === 'eq') return value === target;
              if (filter.op === 'gte') return value >= target;
              if (filter.op === 'lte') return value <= target;
              return false;
            });
          }
          if (scalar.search) {
            const keys = (scalar.searchable_columns || [])
              .map((column) => String(column).match(/([a-z][a-z0-9_]*)$/)?.[1])
              .filter(Boolean);
            const needle = String(scalar.search).toLocaleLowerCase();
            rows = rows.filter((row) => keys.some((key) =>
              String(row.data?.[key] ?? '').toLocaleLowerCase().includes(needle)));
          }
          const endpointExists = (specification, edge, opposite) => {
            const table = {
              custom_object: 'custom_object_record',
              member: 'member',
              organization: 'organization',
              organization_group: 'organization_group',
            }[specification.endpoint_kind];
            return (tables[table] || []).some((endpoint) =>
              endpoint.id === edge[opposite]
              && endpoint.tenant_id === args.p_tenant_id
              && (specification.endpoint_kind !== 'custom_object'
                || (
                  endpoint.custom_object_id === specification.endpoint_custom_object_id
                  && endpoint.archived_at == null
                )));
          };
          for (const filter of args.p_filters || []) {
            const opposite = filter.side === 'source' ? 'target_record_id' : 'source_record_id';
            const routed = filter.side === 'source' ? 'source_record_id' : 'target_record_id';
            const linked = (id) => (tables.custom_object_relationship || []).filter((edge) =>
              edge.tenant_id === args.p_tenant_id && edge.archived_at == null
              && edge.relationship_definition_id === filter.relationship_definition_id
              && edge[routed] === id
              && endpointExists(filter, edge, opposite)).map((edge) => String(edge[opposite]));
            rows = rows.filter((row) => {
              const values = linked(row.id);
              if (filter.op === 'is_empty') return values.length === 0;
              if (filter.op === 'is_not_empty') return values.length > 0;
              const match = filter.values.some((id) => values.includes(String(id)));
              return filter.op === 'any_of' ? match : !match;
            });
          }
          if (args.p_sort) {
            const sort = args.p_sort;
            const opposite = sort.side === 'source' ? 'target_record_id' : 'source_record_id';
            const routed = sort.side === 'source' ? 'source_record_id' : 'target_record_id';
            const valueFor = (row) => {
              const edges = (tables.custom_object_relationship || []).filter((edge) =>
                edge.tenant_id === args.p_tenant_id && edge.archived_at == null
                && edge.relationship_definition_id === sort.relationship_definition_id
                && edge[routed] === row.id
                && endpointExists(sort, edge, opposite));
              if (sort.mode === 'count') return edges.length;
              return edges.map((edge) => (tables.custom_object_record || []).find((endpoint) =>
                endpoint.id === edge[opposite])?.data?.[sort.display_key] || '').sort()[0] || '';
            };
            rows.sort((a, b) => {
              const left = valueFor(a); const right = valueFor(b);
              const result = typeof left === 'number' ? left - right : String(left).localeCompare(String(right));
              return (sort.ascending ? result : -result) || (sort.ascending
                ? String(a.id).localeCompare(String(b.id))
                : String(b.id).localeCompare(String(a.id)));
            });
          } else if (scalar.sort_column) {
            const key = String(scalar.sort_column).match(/([a-z][a-z0-9_]*)$/)?.[1];
            const valueFor = (row) =>
              ['created_at', 'updated_at'].includes(scalar.sort_column)
                ? row[scalar.sort_column]
                : row.data?.[key];
            rows.sort((a, b) => {
              const left = valueFor(a); const right = valueFor(b);
              if (left == null && right == null) return String(a.id).localeCompare(String(b.id));
              if (left == null) return 1;
              if (right == null) return -1;
              const result = typeof left === 'number'
                ? left - right
                : String(left).localeCompare(String(right));
              return (scalar.ascending ? result : -result) || (scalar.ascending
                ? String(a.id).localeCompare(String(b.id))
                : String(b.id).localeCompare(String(a.id)));
            });
          }
          const total = rows.length;
          const page = rows.slice(args.p_offset, args.p_offset + args.p_limit)
            .map((row) => ({ record_id: row.id, total_count: total }));
          return {
            data: page.length ? page : [{ record_id: null, total_count: total }],
            error: null,
          };
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

test('field ACLs prune active and archived definitions while retaining only unknown legacy keys', async () => {
  const archived = field({ id: 'field-archived', name: 'retired_secret', is_active: false });
  const denied = field({ id: 'field-denied', name: 'secret', is_required: false });
  const visible = field({ id: 'field-visible', name: 'title', field_type: 'text', is_required: false });
  const db = mockDb({
    custom_object_definition: [object({ primary_display_field_id: visible.id })],
    custom_object_role_permission: [{ tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true }],
    custom_object_field_role_permission: [
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, field_id: denied.id, access_level: 'none' },
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, field_id: archived.id, access_level: 'none' },
    ],
    preference_field: [visible, denied, archived],
    custom_object_record: [{ id: 'record-1', tenant_id: tenantId, custom_object_id: objectId, data: {
      title: 'Visible', secret: 'Denied', retired_secret: 'Denied historic', unknown_legacy: 'kept',
    } }],
  });
  const record = await createCustomObjectService({ db, context: context() }).getRecord(objectId, 'record-1');
  assert.deepEqual(record.data, { title: 'Visible', unknown_legacy: 'kept' });
});

test('field permissions reject denied query and writes and ignore required read-only fields', async () => {
  const readOnly = field({ id: 'field-read', name: 'required_read_only', field_type: 'text', is_required: true });
  const denied = field({ id: 'field-denied', name: 'secret', is_required: false });
  const writable = field({ id: 'field-write', name: 'title', field_type: 'text', is_required: false });
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_role_permission: [{
      tenant_id: tenantId, custom_object_id: objectId, role_id: roleId,
      can_view_records: true, can_create_records: true, can_edit_records: true,
    }],
    custom_object_field_role_permission: [
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, field_id: readOnly.id, access_level: 'read' },
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, field_id: denied.id, access_level: 'none' },
    ],
    preference_field: [readOnly, denied, writable],
    custom_object_record: [{ id: 'record-1', tenant_id: tenantId, custom_object_id: objectId, data: { title: 'Old', secret: 'x' } }],
  });
  const service = createCustomObjectService({ db, context: context() });
  await service.createRecord(objectId, { data: { title: 'New' } });
  await assert.rejects(() => service.listRecords(objectId, { filters: JSON.stringify({ [denied.id]: { op: 'equals', value: 'x' } }) }), /Unknown or inactive filter field/);
  await assert.rejects(() => service.listRecords(objectId, { sortField: denied.id }), /sortField/);
  await assert.rejects(() => service.updateRecord(objectId, 'record-1', { data: { secret: 'no' } }), /read-only or unavailable/);
  await assert.rejects(() => service.updateRecord(objectId, 'record-1', { data: { required_read_only: 'no' } }), /read-only or unavailable/);
});

test('export requires its object capability and returns only readable fields', async () => {
  const visible = field({ id: 'field-visible', name: 'title', field_type: 'text', is_required: false });
  const denied = field({ id: 'field-denied', name: 'secret', field_type: 'text', is_required: false });
  const seed = {
    custom_object_definition: [object({ primary_display_field_id: visible.id })],
    preference_field: [visible, denied],
    custom_object_field_role_permission: [{ tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, field_id: denied.id, access_level: 'none' }],
    custom_object_record: [{ id: 'record-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { title: 'Public', secret: 'Private' } }],
  };
  const deniedExport = createCustomObjectService({ db: mockDb({
    ...seed,
    custom_object_role_permission: [{ tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true }],
  }), context: context() });
  await assert.rejects(() => deniedExport.exportRecords(objectId, {}), /Access denied/);
  const allowed = createCustomObjectService({ db: mockDb({
    ...seed,
    custom_object_role_permission: [{ tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true, can_export_records: true }],
  }), context: context() });
  const result = await allowed.exportRecords(objectId, {});
  assert.deepEqual(result.columns.map((column) => column.key), ['title']);
  assert.equal(result.data[0].display_value, 'Public');
  assert.deepEqual(result.data[0].data, { title: 'Public' });
  assert.equal(result.total, 1);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 500);
});

test('export transport returns a real one-thousand-record page without interactive-list truncation', async () => {
  const records = Array.from({ length: 1001 }, (_, index) => ({
    id: `record-${String(index).padStart(4, '0')}`,
    tenant_id: tenantId,
    custom_object_id: objectId,
    archived_at: null,
    created_at: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    updated_at: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    data: {},
  }));
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [],
    custom_object_record: records,
  });
  const result = await createCustomObjectService({
    db,
    context: context({ roleId: null }),
    isAdmin: true,
  }).exportRecords(objectId, { page: '1', pageSize: '1000', sortField: 'created_at', sortDir: 'asc' });
  assert.equal(result.data.length, 1000);
  assert.equal(result.total, 1001);
  assert.equal(result.pageSize, 1000);
  const rangeCall = db.calls.find((call) =>
    call.table === 'custom_object_record' && call.type === 'range');
  assert.deepEqual([rangeCall.from, rangeCall.to], [0, 999]);
});

test('field permission listing and upsert require schema access and enforce object-owned fields', async () => {
  const controlled = field({ id: 'field-controlled', is_required: false });
  const seed = {
    custom_object_definition: [object()],
    preference_field: [controlled],
    role: [{ id: roleId, tenant_id: tenantId, name: 'portal' }],
    custom_object_field_role_permission: [],
  };
  const reader = createCustomObjectService({ db: mockDb(seed), context: context() });
  await assert.rejects(() => reader.listFieldPermissions(objectId, {}), /catalogue access required/);
  await assert.rejects(() => reader.upsertFieldPermission(objectId, {
    role_id: roleId, field_id: controlled.id, access_level: 'read',
  }), /management access required/);
  const db = mockDb(seed);
  const manager = createCustomObjectService({
    db, context: context(), canViewSchema: true, canManageSchema: true,
  });
  const saved = await manager.upsertFieldPermission(objectId, {
    role_id: roleId, field_id: controlled.id, access_level: 'read',
  });
  assert.equal(saved.access_level, 'read');
  assert.equal((await manager.listFieldPermissions(objectId, {})).data[0].field_id, controlled.id);
});

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

test('non-admin portal reads fail closed without an object role grant', async () => {
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [field()],
    custom_object_record: [{
      id: 'record-1', tenant_id: tenantId, custom_object_id: objectId,
      archived_at: null, data: { headcount: 1 },
    }],
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    isAdmin: false,
  });
  await assert.rejects(() => service.getObject(objectId), (error) => error.status === 403);
  await assert.rejects(() => service.listFields(objectId, {}), (error) => error.status === 403);
  await assert.rejects(() => service.listRecords(objectId, {}), (error) => error.status === 403);
  await assert.rejects(() => service.getRecord(objectId, 'record-1'), (error) => error.status === 403);
  assert.deepEqual(await service.listObjects({}), {
    data: [], total: 0, page: 1, pageSize: 25,
  });
});

test('record-reader object catalogue omits unprojected presentation metadata', async () => {
  const db = mockDb({
    custom_object_definition: [object({
      primary_display_field_id: 'field-denied',
      configuration: {
        views: {
          detail: {
            version: 2,
            schema_field_ids: ['field-denied'],
            cards: [{
              id: 'private',
              title: 'Private',
              columns: 1,
              fields: [{
                id: 'field:field-denied',
                type: 'field',
                field_id: 'field-denied',
                columnIndex: 0,
              }],
            }],
          },
        },
      },
    })],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
    }],
  });
  const result = await createCustomObjectService({
    db,
    context: context(),
    isAdmin: false,
  }).listObjects({ status: 'active' });
  assert.equal(result.data.length, 1);
  assert.equal(Object.hasOwn(result.data[0], 'configuration'), false);
  assert.equal(Object.hasOwn(result.data[0], 'primary_display_field_id'), false);
  assert.equal(result.data[0].capabilities.view, true);
});

test('object reads safely reconcile versioned CRM presentation against current fields', async () => {
  const retained = field({ id: 'field-retained', name: 'title', is_required: false });
  const added = field({ id: 'field-added', name: 'code', is_required: false });
  const db = mockDb({
    custom_object_definition: [object({
      configuration: {
        views: {
          detail: {
            version: 2,
            schema_field_ids: [retained.id],
            cards: [{
              id: 'card-details',
              title: 'Details',
              columns: 1,
              fields: [
                {
                  id: 'custom:field-retained',
                  type: 'custom',
                  fieldId: `custom:${retained.id}`,
                  columnIndex: 0,
                },
                { id: 'field:removed', type: 'field', field_id: 'removed', columnIndex: 0 },
              ],
            }],
          },
        },
      },
    })],
    preference_field: [retained, added],
    custom_object_relationship_definition: [],
    custom_object_role_permission: [{
      tenant_id: tenantId, custom_object_id: objectId, role_id: roleId,
      can_view_records: true,
    }],
  });
  const result = await createCustomObjectService({ db, context: context() }).getObject(objectId);
  assert.deepEqual(
    result.configuration.views.detail.cards.flatMap((card) => card.fields).map((item) => item.id),
    ['custom:field-retained', 'field:field-added'],
  );
  assert.equal(db.tables.custom_object_definition[0].configuration.views.detail.cards[0].fields.length, 2);
});

test('record-reader object metadata prunes denied fields and stale dependent rules', async () => {
  const visible = field({ id: 'field-visible', name: 'title', is_required: false });
  const denied = field({ id: 'field-denied', name: 'secret', is_required: false });
  const db = mockDb({
    custom_object_definition: [object({
      configuration: {
        views: {
          detail: {
            version: 2,
            schema_field_ids: [visible.id, denied.id],
            cards: [{
              id: 'card-details',
              title: 'Details',
              columns: 1,
              fields: [
                { id: `field:${visible.id}`, type: 'field', field_id: visible.id, columnIndex: 0 },
                { id: `field:${denied.id}`, type: 'field', field_id: denied.id, columnIndex: 0 },
              ],
            }],
            visibility_rules: [{
              id: 'private-rule',
              conditions: [{ field_id: denied.id, operator: 'not_empty' }],
              actions: [{
                action_type: 'hide',
                target_type: 'field',
                target_field_id: `field:${visible.id}`,
              }],
            }],
          },
        },
      },
    })],
    preference_field: [visible, denied],
    custom_object_relationship_definition: [],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
    }],
    custom_object_field_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      field_id: denied.id,
      access_level: 'none',
    }],
  });
  const result = await createCustomObjectService({ db, context: context() }).getObject(objectId);
  assert.deepEqual(result.configuration.views.detail.schema_field_ids, [visible.id]);
  assert.deepEqual(
    result.configuration.views.detail.cards.flatMap((card) => card.fields).map((item) => item.id),
    [`field:${visible.id}`],
  );
  assert.deepEqual(result.configuration.views.detail.visibility_rules, []);
});

test('hidden relationship sides reject direct non-admin create and archive mutations', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetObjectId, object_key: 'target' }),
    ],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetObjectId,
      show_on_source: false,
      show_on_target: true,
      edit_from_source: true,
      edit_from_target: true,
    }],
    custom_object_record: [
      { id: 'source-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null },
      { id: 'target-1', tenant_id: tenantId, custom_object_id: targetObjectId, archived_at: null },
    ],
    custom_object_relationship: [{
      id: 'edge-1',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'target-1',
      archived_at: null,
    }],
    custom_object_role_permission: [
      {
        tenant_id: tenantId,
        custom_object_id: objectId,
        role_id: roleId,
        can_view_records: true,
        can_edit_records: true,
      },
      {
        tenant_id: tenantId,
        custom_object_id: targetObjectId,
        role_id: roleId,
        can_view_records: true,
        can_edit_records: true,
      },
    ],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: false });
  await assert.rejects(
    () => service.createRelationship(objectId, {
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'target-1',
      routed_side: 'source',
      routed_record_id: 'source-1',
    }),
    (error) => error.status === 403 && /hidden/.test(error.message),
  );
  await assert.rejects(
    () => service.archiveRelationship(objectId, 'edge-1', {
      routed_side: 'source',
      routed_record_id: 'source-1',
    }),
    (error) => error.status === 403 && /hidden/.test(error.message),
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

test('atomic record creation routes an originating edge and additional edges through the tenant RPC', async () => {
  const relatedObjectId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object(), object({ id: relatedObjectId, object_key: 'regions' })],
    preference_field: [field()],
    custom_object_role_permission: [
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true, can_create_records: true, can_edit_records: true },
      { tenant_id: tenantId, custom_object_id: relatedObjectId, role_id: roleId, can_view_records: true, can_edit_records: true },
    ],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: relatedObjectId,
      target_kind: 'custom_object', target_custom_object_id: objectId,
      show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
    }],
    custom_object_record: [{ id: 'region-1', tenant_id: tenantId, custom_object_id: relatedObjectId, archived_at: null }],
  });
  const result = await createCustomObjectService({ db, context: context() }).createRecordWithRelationships(objectId, {
    data: { headcount: 4 },
    originating_relationship: {
      relationship_definition_id: definitionId, routed_side: 'target', related_record_id: 'region-1',
    },
  });
  assert.equal(result.record.data.headcount, 4);
  const rpc = db.calls.find((call) => call.type === 'rpc' && call.name === 'create_custom_object_record_with_relationships');
  assert.equal(rpc.args.p_tenant_id, tenantId);
  assert.deepEqual(rpc.args.p_relationships, [{
    relationship_definition_id: definitionId, routed_side: 'target', related_record_id: 'region-1', originating: true,
  }]);
});

test('missing atomic create RPC returns an actionable service error without non-transactional fallback', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [field()],
    custom_object_role_permission: [{
      tenant_id: tenantId, custom_object_id: objectId, role_id: roleId,
      can_view_records: true, can_create_records: true, can_edit_records: true,
    }],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'member', target_custom_object_id: null,
      show_on_source: true, edit_from_source: true,
    }],
    member: [{ id: 'member-2', tenant_id: tenantId }],
  });
  const originalRpc = db.rpc;
  db.rpc = (name, args) => {
    if (name !== 'create_custom_object_record_with_relationships') return originalRpc(name, args);
    db.calls.push({ type: 'rpc', name, args });
    return {
      async single() {
        return {
          data: null,
          error: {
            code: 'PGRST202',
            message: 'Could not find the function public.create_custom_object_record_with_relationships in the schema cache',
          },
        };
      },
    };
  };

  await assert.rejects(
    () => createCustomObjectService({ db, context: context(), isAdmin: true }).createRecordWithRelationships(objectId, {
      data: { headcount: 4 },
      initial_relationships: [{
        relationship_definition_id: definitionId,
        routed_side: 'source',
        related_record_id: 'member-2',
      }],
    }),
    (error) => error.status === 503
      && /20260925_custom_object_record_relationship_create\.sql/.test(error.message),
  );
  assert.equal(db.tables.custom_object_record?.length || 0, 0);
});

test('originating relationship uses the existing core card metadata, not the new record metadata', async () => {
  const definitionId = '66666666-6666-4666-8666-666666666666';
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [field()],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'organization', target_custom_object_id: null,
      show_on_source: true, edit_from_source: false, show_on_target: true, edit_from_target: true,
    }],
    organization: [{ id: 'organization-1', tenant_id: tenantId, name: 'Existing card' }],
  });
  await createCustomObjectService({ db, context: context(), isAdmin: true }).createRecordWithRelationships(objectId, {
    data: { headcount: 4 },
    originating_relationship: {
      relationship_definition_id: definitionId, routed_side: 'source', related_record_id: 'organization-1',
    },
  });
  assert.ok(db.calls.some((call) => call.type === 'rpc'
    && call.name === 'create_custom_object_record_with_relationships'));
});

test('initial relationship candidate picker excludes saturated opposite endpoints without a routed record', async () => {
  const relatedObjectId = '77777777-7777-4777-8777-777777777777';
  const definitionId = '88888888-8888-4888-8888-888888888888';
  const db = mockDb({
    custom_object_definition: [object(), object({ id: relatedObjectId, object_key: 'regions' })],
    preference_field: [field(), field({ id: 'region-name', custom_object_id: relatedObjectId, name: 'headcount', is_required: false })],
    custom_object_role_permission: [
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true, can_create_records: true, can_edit_records: true },
      { tenant_id: tenantId, custom_object_id: relatedObjectId, role_id: roleId, can_view_records: true, can_edit_records: true },
    ],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'one_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'custom_object', target_custom_object_id: relatedObjectId,
      show_on_source: true, edit_from_source: true, show_on_target: true, edit_from_target: true,
    }],
    custom_object_record: [
      { id: 'available', tenant_id: tenantId, custom_object_id: relatedObjectId, data: { headcount: 2 }, archived_at: null },
      { id: 'saturated', tenant_id: tenantId, custom_object_id: relatedObjectId, data: { headcount: 3 }, archived_at: null },
    ],
    custom_object_relationship: [{
      tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'old-source',
      target_record_id: 'saturated', archived_at: null,
    }],
  });
  const result = await createCustomObjectService({ db, context: context() }).initialRelationshipCandidates(objectId, {
    definitionId, newRecordSide: 'source',
  });
  assert.deepEqual(result.data.map((row) => row.id), ['available']);
  assert.equal(result.data[0].kind, 'custom_object');
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

test('record list metadata unifies readable scalar fields and permission-pruned relationship sides', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const hiddenTargetId = '55555555-5555-4555-8555-555555555555';
  const display = field({
    id: 'display-field', custom_object_id: targetId, name: 'name',
    label: 'Name', field_type: 'text', is_required: false,
  });
  const deniedListField = field({ id: 'denied-list', name: 'private', field_type: 'text' });
  const multi = field({ id: 'multi', name: 'tags', field_type: 'picklist', is_required: false });
  const attachment = field({ id: 'attachment', name: 'attachment', field_type: 'file', is_required: false });
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetId, object_key: 'teams', primary_display_field_id: display.id }),
      object({ id: hiddenTargetId, object_key: 'private_teams' }),
    ],
    preference_field: [field({ id: 'scalar' }), deniedListField, multi, attachment, display],
    custom_object_role_permission: [
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true },
      { tenant_id: tenantId, custom_object_id: targetId, role_id: roleId, can_view_records: true },
    ],
    custom_object_field_role_permission: [
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, field_id: deniedListField.id, access_level: 'none' },
      { tenant_id: tenantId, custom_object_id: targetId, role_id: roleId, field_id: display.id, access_level: 'none' },
    ],
    custom_object_relationship_definition: [
      {
        id: 'visible-relation', tenant_id: tenantId, status: 'active',
        cardinality: 'one_to_many', source_kind: 'custom_object',
        source_custom_object_id: objectId, target_kind: 'custom_object',
        target_custom_object_id: targetId, source_label: 'Teams', show_on_source: true,
      },
      {
        id: 'inaccessible-relation', tenant_id: tenantId, status: 'active',
        cardinality: 'many_to_many', source_kind: 'custom_object',
        source_custom_object_id: objectId, target_kind: 'custom_object',
        target_custom_object_id: hiddenTargetId, show_on_source: true,
      },
      {
        id: 'inactive-relation', tenant_id: tenantId, status: 'archived',
        source_kind: 'custom_object', source_custom_object_id: objectId,
        target_kind: 'custom_object', target_custom_object_id: targetId,
      },
    ],
    custom_object_record: [],
  });
  const result = await createCustomObjectService({ db, context: context() }).listRecords(objectId, {});
  assert.deepEqual(result.metadata.fields.map((item) => item.id), ['attachment', 'multi', 'scalar']);
  assert.deepEqual(result.metadata.fields.find((item) => item.id === multi.id), {
    id: 'multi',
    kind: 'field',
    field_id: 'multi',
    key: 'tags',
    label: 'Headcount',
    field_type: 'picklist',
    value_shape: 'array',
    operators: ['any_of', 'none_of'],
    filterable: true,
    sortable: true,
  });
  assert.deepEqual(result.metadata.fields.find((item) => item.id === attachment.id), {
    id: 'attachment',
    kind: 'field',
    field_id: 'attachment',
    key: 'attachment',
    label: 'Headcount',
    field_type: 'file',
    value_shape: 'file',
    operators: [],
    filterable: false,
    sortable: false,
  });
  assert.deepEqual(result.metadata.relationships, []);
});

test('relationship filter options search core endpoints through a tenant-scoped permission-safe route', async () => {
  const relationId = 'organization-relation';
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
    }],
    custom_object_relationship_definition: [{
      id: relationId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_one',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'organization',
      target_custom_object_id: null,
      source_label: 'Organisation',
      show_on_source: true,
    }],
    organization: [
      { id: 'org-alpha', tenant_id: tenantId, name: 'Alpha Group', email: 'alpha@example.test' },
      { id: 'org-beta', tenant_id: tenantId, name: 'Beta Group' },
      { id: 'org-foreign', tenant_id: 'other-tenant', name: 'Alpha Foreign' },
    ],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  const result = await service.relationshipFilterOptions(objectId, {
    fieldId: `relationship:${relationId}:source`,
    search: 'alpha',
    selected: JSON.stringify(['org-beta']),
    page: '1',
    pageSize: '50',
  });
  assert.equal(result.total, 1);
  assert.deepEqual(result.data, [
    {
      id: 'org-beta',
      kind: 'organization',
      custom_object_id: null,
      primary_label: 'Beta Group',
      secondary_text: null,
    },
    {
      id: 'org-alpha',
      kind: 'organization',
      custom_object_id: null,
      primary_label: 'Alpha Group',
      secondary_text: 'alpha@example.test',
    },
  ]);

  await assert.rejects(
    () => createCustomObjectService({
      db,
      context: context(),
    }).relationshipFilterOptions(objectId, {
      fieldId: `relationship:${relationId}:source`,
    }),
    (error) => error.status === 400 && /inaccessible relationship/.test(error.message),
  );
});

test('relationship filtering ignores inactive, archived, and cross-tenant endpoints and reports exact total', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const relationId = 'relation-filter';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetId, object_key: 'teams', primary_display_field_id: 'target-name' }),
    ],
    preference_field: [
      field({ id: 'target-name', custom_object_id: targetId, name: 'name', field_type: 'text', is_required: false }),
    ],
    custom_object_relationship_definition: [{
      id: relationId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'custom_object', target_custom_object_id: targetId, show_on_source: true,
    }],
    custom_object_record: [
      ...['source-valid', 'source-archived', 'source-foreign', 'source-empty'].map((id) => ({
        id, tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: {},
      })),
      { id: 'valid-target', tenant_id: tenantId, custom_object_id: targetId, archived_at: null, data: { name: 'Valid' } },
      { id: 'archived-target', tenant_id: tenantId, custom_object_id: targetId, archived_at: '2026-01-01', data: { name: 'Old' } },
      { id: 'foreign-target', tenant_id: 'other-tenant', custom_object_id: targetId, archived_at: null, data: { name: 'Foreign' } },
    ],
    custom_object_relationship: [
      { relationship_definition_id: relationId, tenant_id: tenantId, source_record_id: 'source-valid', target_record_id: 'valid-target', archived_at: null },
      { relationship_definition_id: relationId, tenant_id: tenantId, source_record_id: 'source-archived', target_record_id: 'archived-target', archived_at: null },
      { relationship_definition_id: relationId, tenant_id: tenantId, source_record_id: 'source-foreign', target_record_id: 'foreign-target', archived_at: null },
    ],
  });
  const key = `relationship:${relationId}:source`;
  const result = await createCustomObjectService({
    db, context: context(), isAdmin: true,
  }).listRecords(objectId, {
    pageSize: 1,
    relationshipFilters: JSON.stringify({ [key]: { op: 'is_not_empty' } }),
  });
  assert.equal(result.total, 1);
  assert.deepEqual(result.data.map((row) => row.id), ['source-valid']);
  assert.equal(result.data[0].relationships[key].count, 1);
  assert.equal(result.data[0].relationships[key].records[0].primary_label, 'Valid');
});

test('relationship RPC combines search and typed scalar filters before exact totals and pagination', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const relationId = 'combined-relation';
  const title = field({ id: 'field-title', name: 'title', label: 'Title', field_type: 'text', is_required: false });
  const headcount = field({ id: 'field-count', name: 'headcount', field_type: 'number', is_required: false });
  const opened = field({ id: 'field-opened', name: 'opened', field_type: 'date', is_required: false });
  const active = field({ id: 'field-active', name: 'active', field_type: 'boolean', is_required: false });
  const tags = field({ id: 'field-tags', name: 'tags', field_type: 'picklist', is_required: false });
  const targetName = field({
    id: 'target-name',
    custom_object_id: targetId,
    name: 'name',
    label: 'Name',
    field_type: 'text',
    is_required: false,
  });
  const source = (id, data) => ({
    id,
    tenant_id: tenantId,
    custom_object_id: objectId,
    archived_at: null,
    data,
  });
  const base = {
    title: 'Needle department',
    headcount: 30,
    opened: '2026-06-01',
    active: true,
    tags: ['green', 'priority'],
  };
  const db = mockDb({
    custom_object_definition: [
      object({ primary_display_field_id: title.id }),
      object({ id: targetId, object_key: 'teams', primary_display_field_id: targetName.id }),
    ],
    preference_field: [title, headcount, opened, active, tags, targetName],
    custom_object_relationship_definition: [{
      id: relationId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetId,
      source_label: 'Teams',
      show_on_source: true,
    }],
    custom_object_record: [
      source('source-match', base),
      source('source-low', { ...base, headcount: 10 }),
      source('source-late', { ...base, opened: '2027-01-01' }),
      source('source-inactive', { ...base, active: false }),
      source('source-blue', { ...base, tags: ['blue'] }),
      source('source-unlinked', base),
      {
        id: 'target-match',
        tenant_id: tenantId,
        custom_object_id: targetId,
        archived_at: null,
        data: { name: 'Target team' },
      },
    ],
    custom_object_relationship: [
      ...['source-match', 'source-low', 'source-late', 'source-inactive', 'source-blue'].map((id) => ({
        id: `edge-${id}`,
        relationship_definition_id: relationId,
        tenant_id: tenantId,
        source_record_id: id,
        target_record_id: 'target-match',
        archived_at: null,
      })),
    ],
  });
  const key = `relationship:${relationId}:source`;
  const service = createCustomObjectService({
    db,
    context: context(),
    isAdmin: true,
  });
  const result = await service.listRecords(objectId, {
    page: 1,
    pageSize: 1,
    search: 'needle',
    sortField: headcount.id,
    sortDir: 'asc',
    filters: JSON.stringify({
      [title.id]: { op: 'contains', value: 'department' },
      [headcount.id]: { op: 'gte', value: 20 },
      [opened.id]: { op: 'lte', value: '2026-12-31' },
      [active.id]: { op: 'equals', value: true },
      [tags.id]: { op: 'any_of', value: ['green'] },
      [key]: { op: 'any_of', value: ['target-match'] },
    }),
  });
  assert.equal(result.total, 1);
  assert.deepEqual(result.data.map((row) => row.id), ['source-match']);
  const rpc = db.calls.find((call) =>
    call.type === 'rpc' && call.name === 'custom_object_record_relationship_list');
  assert.equal(rpc.args.p_scalar_plan.filters.length, 5);
  assert.equal(rpc.args.p_scalar_plan.search, 'needle');
  assert.equal(rpc.args.p_scalar_plan.sort_column, 'data->headcount');
  assert.deepEqual(rpc.args.p_filters[0].values, ['target-match']);
});

test('relationship count sorting is numeric and stable before pagination', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const relationId = 'count-sort-relation';
  const sourceName = field({ id: 'source-name', name: 'name', field_type: 'text', is_required: false });
  const targetName = field({
    id: 'target-name',
    custom_object_id: targetId,
    name: 'name',
    field_type: 'text',
    is_required: false,
  });
  const sources = Array.from({ length: 12 }, (_, count) => ({
    id: `source-${String(count).padStart(2, '0')}`,
    tenant_id: tenantId,
    custom_object_id: objectId,
    archived_at: null,
    data: { name: `Source ${count}` },
  }));
  const targets = [];
  const edges = [];
  for (let count = 0; count < sources.length; count += 1) {
    for (let edgeIndex = 0; edgeIndex < count; edgeIndex += 1) {
      const targetRecordId = `target-${count}-${edgeIndex}`;
      targets.push({
        id: targetRecordId,
        tenant_id: tenantId,
        custom_object_id: targetId,
        archived_at: null,
        data: { name: `Target ${count}-${edgeIndex}` },
      });
      edges.push({
        id: `edge-${count}-${edgeIndex}`,
        relationship_definition_id: relationId,
        tenant_id: tenantId,
        source_record_id: sources[count].id,
        target_record_id: targetRecordId,
        archived_at: null,
      });
    }
  }
  const db = mockDb({
    custom_object_definition: [
      object({ primary_display_field_id: sourceName.id }),
      object({ id: targetId, object_key: 'teams', primary_display_field_id: targetName.id }),
    ],
    preference_field: [sourceName, targetName],
    custom_object_relationship_definition: [{
      id: relationId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetId,
      source_label: 'Teams',
      show_on_source: true,
    }],
    custom_object_record: [...sources, ...targets],
    custom_object_relationship: edges,
  });
  const service = createCustomObjectService({
    db,
    context: context(),
    isAdmin: true,
  });
  const result = await service.listRecords(objectId, {
    page: 1,
    pageSize: 3,
    relationshipSort: `relationship:${relationId}:source`,
    relationshipSortMode: 'count',
    sortDir: 'desc',
  });
  assert.equal(result.total, 12);
  assert.deepEqual(result.data.map((row) => row.id), ['source-11', 'source-10', 'source-09']);
  const largest = result.data[0].relationships[`relationship:${relationId}:source`];
  assert.equal(largest.count, 11);
  assert.equal(largest.records.length, 3);
  const projectionCall = db.calls.find((call) =>
    call.type === 'rpc' && call.name === 'custom_object_record_relationship_projection');
  assert.equal(projectionCall.args.p_label_limit, 3);
  assert.equal(db.calls.some((call) => call.type === 'from' && call.table === 'custom_object_relationship'), false);

  const beyondLastPage = await service.listRecords(objectId, {
    page: 99,
    pageSize: 3,
    relationshipSort: `relationship:${relationId}:source`,
    relationshipSortMode: 'count',
    sortDir: 'desc',
  });
  assert.equal(beyondLastPage.total, 12);
  assert.deepEqual(beyondLastPage.data, []);
});

test('relationship projection validates a bounded requested column inventory', async () => {
  const db = mockDb({
    custom_object_definition: [object()],
    preference_field: [],
    custom_object_record: [],
  });
  await assert.rejects(
    () => createCustomObjectService({
      db,
      context: context(),
      isAdmin: true,
    }).listRecords(objectId, {
      relationshipColumns: JSON.stringify(Array.from({ length: 101 }, (_, index) => `relationship:${index}:source`)),
    }),
    (error) => error.status === 400 && /at most 100/.test(error.message),
  );
});

test('relationship label projection chunks large endpoint ID lookups', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const relationId = 'projection-chunk-relation';
  const key = `relationship:${relationId}:source`;
  const sourceName = field({
    id: 'source-name',
    name: 'name',
    field_type: 'text',
    is_required: false,
  });
  const targetName = field({
    id: 'target-name',
    custom_object_id: targetId,
    name: 'name',
    field_type: 'text',
    is_required: false,
  });
  const sources = Array.from({ length: 70 }, (_, index) => ({
    id: `source-${index}`,
    tenant_id: tenantId,
    custom_object_id: objectId,
    archived_at: null,
    data: { name: `Source ${index}` },
  }));
  const targets = [];
  const edges = [];
  for (const source of sources) {
    for (let index = 0; index < 3; index += 1) {
      const targetRecordId = `target-${source.id}-${index}`;
      targets.push({
        id: targetRecordId,
        tenant_id: tenantId,
        custom_object_id: targetId,
        archived_at: null,
        data: { name: `Target ${source.id}-${index}` },
      });
      edges.push({
        id: `edge-${source.id}-${index}`,
        tenant_id: tenantId,
        relationship_definition_id: relationId,
        source_record_id: source.id,
        target_record_id: targetRecordId,
        archived_at: null,
      });
    }
  }
  const db = mockDb({
    custom_object_definition: [
      object({ primary_display_field_id: sourceName.id }),
      object({ id: targetId, object_key: 'teams', primary_display_field_id: targetName.id }),
    ],
    preference_field: [sourceName, targetName],
    custom_object_relationship_definition: [{
      id: relationId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetId,
      source_label: 'Teams',
      show_on_source: true,
    }],
    custom_object_record: [...sources, ...targets],
    custom_object_relationship: edges,
  });
  const result = await createCustomObjectService({
    db,
    context: context(),
    isAdmin: true,
  }).listRecords(objectId, {
    page: 1,
    pageSize: 100,
    relationshipColumns: JSON.stringify([key]),
  });
  assert.equal(result.data.length, 70);
  assert.ok(result.data.every((row) =>
    row.relationships[key].count === 3 && row.relationships[key].records.length === 3));
  const endpointBatches = db.calls.filter((call) =>
    call.type === 'in'
    && call.table === 'custom_object_record'
    && call.column === 'id'
    && call.values.some((id) => String(id).startsWith('target-')));
  assert.deepEqual(endpointBatches.map((call) => call.values.length), [200, 10]);
});

test('missing relationship list RPC returns an actionable 503 without an in-memory fallback', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const relationId = 'missing-rpc-relation';
  const display = field({
    id: 'target-name',
    custom_object_id: targetId,
    name: 'name',
    field_type: 'text',
    is_required: false,
  });
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetId, object_key: 'teams', primary_display_field_id: display.id }),
    ],
    preference_field: [display],
    custom_object_relationship_definition: [{
      id: relationId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetId,
      source_label: 'Teams',
      show_on_source: true,
    }],
  });
  const originalRpc = db.rpc;
  db.rpc = (name, args) => {
    if (name !== 'custom_object_record_relationship_list') return originalRpc(name, args);
    db.calls.push({ type: 'rpc', name, args });
    return Promise.resolve({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.custom_object_record_relationship_list in the schema cache',
      },
    });
  };
  await assert.rejects(
    () => createCustomObjectService({
      db,
      context: context(),
      isAdmin: true,
    }).listRecords(objectId, {
      relationshipFilters: JSON.stringify({
        [`relationship:${relationId}:source`]: { op: 'is_not_empty' },
      }),
    }),
    (error) => error.status === 503
      && /20260928_custom_object_relationship_list_rpc\.sql/.test(error.message),
  );
});

test('relationship label sorting is stable before pagination and export uses the same result contract', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const relationId = 'relation-sort';
  const sourceRows = Array.from({ length: 125 }, (_, index) => ({
    id: `source-${String(index).padStart(3, '0')}`,
    tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: {},
  }));
  const targetRows = sourceRows.map((source, index) => ({
    id: `target-${index}`, tenant_id: tenantId, custom_object_id: targetId,
    archived_at: null, data: { name: `Label ${String(124 - index).padStart(3, '0')}` },
  }));
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetId, object_key: 'teams', primary_display_field_id: 'target-name' }),
    ],
    preference_field: [
      field({ id: 'target-name', custom_object_id: targetId, name: 'name', field_type: 'text', is_required: false }),
    ],
    custom_object_relationship_definition: [{
      id: relationId, tenant_id: tenantId, status: 'active', cardinality: 'one_to_one',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'custom_object', target_custom_object_id: targetId, show_on_source: true,
    }],
    custom_object_record: [...sourceRows, ...targetRows],
    custom_object_relationship: sourceRows.map((source, index) => ({
      id: `edge-${index}`, relationship_definition_id: relationId, tenant_id: tenantId,
      source_record_id: source.id, target_record_id: `target-${index}`, archived_at: null,
    })),
  });
  const key = `relationship:${relationId}:source`;
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  const page = await service.listRecords(objectId, {
    page: 3, pageSize: 10, relationshipSort: key, sortDir: 'asc',
  });
  assert.equal(page.total, 125);
  assert.deepEqual(page.data.map((row) => row.id), sourceRows.slice(95, 105).map((row) => row.id).reverse());
  const exported = await service.exportRecords(objectId, {
    page: 3, pageSize: 10, relationshipSort: key, sortDir: 'asc',
  });
  assert.deepEqual(exported.data.map((row) => row.id), page.data.map((row) => row.id));
  assert.equal(exported.total, 125);
  assert.deepEqual(exported.relationship_columns, page.metadata.relationships);
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
      { id: 'role-z', tenant_id: tenantId, name: 'Zeta', is_system: false },
      { id: 'role-a', tenant_id: tenantId, name: 'Alpha', is_system: true },
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
    && call.type === 'select'
    && call.columns === 'id,name,is_system'));
  assert.equal(db.calls.some((call) =>
    call.table === 'role'
    && call.type === 'select'
    && call.columns.includes('label')), false);
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
    }, {
      id: '66666666-6666-4666-8666-666666666666',
      tenant_id: tenantId,
      relationship_key: 'location_organization',
      source_kind: 'custom_object',
      source_custom_object_id: targetObjectId,
      target_kind: 'organization',
      target_custom_object_id: null,
      cardinality: 'many_to_one',
      source_label: 'Organization',
      target_label: 'Locations',
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
  await assert.rejects(
    () => service.updateRelationshipDefinition(objectId, definitionId, {
      configuration: {
        picker_scope: {
          version: 2,
          match: 'intersects',
          source_path: [{
            relationship_definition_id: 'missing-source-path',
            from_side: 'source',
          }],
          target_path: [{
            relationship_definition_id: 'missing-target-path',
            from_side: 'target',
          }],
        },
      },
    }),
    (error) => error.status === 409 && /unavailable relationship/.test(error.message),
  );
  await assert.rejects(
    () => service.updateRelationshipDefinition(objectId, definitionId, {
      configuration: {
        compact_preview: {
          target_columns: [{
            type: 'relationship',
            relationship_definition_id: '66666666-6666-4666-8666-666666666666',
            side: 'target',
            label: 'Organization',
          }],
        },
      },
    }),
    (error) => error.status === 400
      && /Invalid compact preview configuration/.test(error.message)
      && error.details?.some((detail) => /unavailable relationship/.test(detail)),
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

test('configured compact previews follow the opposite endpoint in both picker directions', async () => {
  const sourceId = objectId;
  const targetId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const sourceField = field({ id: 'field-source', name: 'source_note', field_type: 'text', is_required: false });
  const targetField = field({ id: 'field-target', custom_object_id: targetId, name: 'target_note', field_type: 'text', is_required: false });
  const db = mockDb({
    custom_object_definition: [object({ id: sourceId }), object({ id: targetId, object_key: 'targets' })],
    preference_field: [sourceField, targetField],
    custom_object_record: [
      { id: 'source-record', tenant_id: tenantId, custom_object_id: sourceId, archived_at: null, data: { source_note: 'Source preview' } },
      { id: 'target-record', tenant_id: tenantId, custom_object_id: targetId, archived_at: null, data: { target_note: 'Target preview' } },
    ],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: sourceId,
      target_kind: 'custom_object', target_custom_object_id: targetId,
      show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
      configuration: { compact_preview: { source_field_ids: [sourceField.id], target_field_ids: [targetField.id] } },
    }],
    custom_object_role_permission: [
      { tenant_id: tenantId, custom_object_id: sourceId, role_id: roleId, can_view_records: true, can_create_records: true, can_edit_records: true },
      { tenant_id: tenantId, custom_object_id: targetId, role_id: roleId, can_view_records: true, can_create_records: true, can_edit_records: true },
    ],
  });
  const service = createCustomObjectService({ db, context: context() });
  const fromSource = await service.entityPicker(sourceId, { definitionId, recordId: 'source-record', side: 'source' });
  const fromTarget = await service.entityPicker(targetId, { definitionId, recordId: 'target-record', side: 'target' });
  const initialFromSource = await service.initialRelationshipCandidates(sourceId, { definitionId, newRecordSide: 'source' });
  const initialFromTarget = await service.initialRelationshipCandidates(targetId, { definitionId, newRecordSide: 'target' });
  assert.equal(fromSource.data[0].compact_fields[0].value, 'Target preview');
  assert.equal(fromTarget.data[0].compact_fields[0].value, 'Source preview');
  assert.equal(initialFromSource.data[0].compact_fields[0].value, 'Target preview');
  assert.equal(initialFromTarget.data[0].compact_fields[0].value, 'Source preview');
});

test('member relationship cards project owning organisations for duplicate department labels', async () => {
  const memberDepartmentId = '55555555-5555-4555-8555-555555555555';
  const departmentOrganizationId = '66666666-6666-4666-8666-666666666666';
  const nameField = field({
    id: 'field-name',
    name: 'name',
    field_type: 'text',
    is_required: false,
  });
  const categoryField = field({
    id: 'field-category',
    name: 'category',
    label: 'Category',
    field_type: 'text',
    is_required: false,
  });
  const db = mockDb({
    custom_object_definition: [object({ primary_display_field_id: nameField.id })],
    preference_field: [nameField, categoryField],
    custom_object_record: [
      { id: 'department-a', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'Imaging', category: 'Clinical' } },
      { id: 'department-b', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, data: { name: 'Imaging', category: 'Research' } },
    ],
    member: [{ id: 'member-1', tenant_id: tenantId, first_name: 'Ada', last_name: 'Lovelace' }],
    organization: [
      { id: 'organization-a', tenant_id: tenantId, name: 'Alpha Hospital' },
      { id: 'organization-b', tenant_id: tenantId, name: 'Beta Hospital' },
    ],
    custom_object_relationship_definition: [{
      id: memberDepartmentId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_many',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'member',
      target_custom_object_id: null,
      show_on_target: true,
      configuration: {
        compact_preview_fields: { source_field_ids: [categoryField.id] },
        compact_preview: { source_columns: [{
        type: 'relationship',
        relationship_definition_id: departmentOrganizationId,
        side: 'source',
        label: 'Organisation',
        }] },
      },
    }, {
      id: departmentOrganizationId,
      tenant_id: tenantId,
      status: 'active',
      cardinality: 'many_to_one',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'organization',
      target_custom_object_id: null,
      source_label: 'Organisations',
      target_label: 'Departments',
    }],
    custom_object_relationship: [{
      id: 'member-edge-a', tenant_id: tenantId, relationship_definition_id: memberDepartmentId,
      source_record_id: 'department-a', target_record_id: 'member-1', archived_at: null, created_at: '2026-01-02',
    }, {
      id: 'member-edge-b', tenant_id: tenantId, relationship_definition_id: memberDepartmentId,
      source_record_id: 'department-b', target_record_id: 'member-1', archived_at: null, created_at: '2026-01-01',
    }, {
      id: 'owner-edge-a', tenant_id: tenantId, relationship_definition_id: departmentOrganizationId,
      source_record_id: 'department-a', target_record_id: 'organization-a', archived_at: null,
    }, {
      id: 'owner-edge-b', tenant_id: tenantId, relationship_definition_id: departmentOrganizationId,
      source_record_id: 'department-b', target_record_id: 'organization-b', archived_at: null,
    }],
  });
  const result = await createCustomObjectService({
    db, context: context(), isAdmin: true,
  }).listCoreRelationships('member', 'member-1', {
    definitionId: memberDepartmentId,
    page: 1,
    pageSize: 10,
  });
  assert.deepEqual(result.data.map((row) => ({
    department: row.related.primary_label,
    category: row.related.compact_fields[0].value,
    organization: row.related.relationship_columns[0].value.primary_label,
    kind: row.related.relationship_columns[0].value.kind,
  })), [
    { department: 'Imaging', category: 'Clinical', organization: 'Alpha Hospital', kind: 'organization' },
    { department: 'Imaging', category: 'Research', organization: 'Beta Hospital', kind: 'organization' },
  ]);
});

test('inaccessible direct relationship columns are omitted without hiding the base row', async () => {
  const targetId = '44444444-4444-4444-8444-444444444444';
  const restrictedId = '77777777-7777-4777-8777-777777777777';
  const cardDefinitionId = '55555555-5555-4555-8555-555555555555';
  const directDefinitionId = '66666666-6666-4666-8666-666666666666';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetId, object_key: 'targets' }),
      object({ id: restrictedId, object_key: 'restricted' }),
    ],
    preference_field: [],
    custom_object_record: [
      { id: 'source-record', tenant_id: tenantId, custom_object_id: objectId, archived_at: null },
      { id: 'target-record', tenant_id: tenantId, custom_object_id: targetId, archived_at: null },
      { id: 'restricted-record', tenant_id: tenantId, custom_object_id: restrictedId, archived_at: null },
    ],
    custom_object_role_permission: [
      { tenant_id: tenantId, custom_object_id: objectId, role_id: roleId, can_view_records: true },
      { tenant_id: tenantId, custom_object_id: targetId, role_id: roleId, can_view_records: true },
    ],
    custom_object_relationship_definition: [{
      id: cardDefinitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'custom_object', target_custom_object_id: targetId,
      show_on_source: true,
      configuration: { compact_preview: { target_columns: [{
        type: 'relationship', relationship_definition_id: directDefinitionId,
        side: 'source', label: 'Restricted',
      }] } },
    }, {
      id: directDefinitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: targetId,
      target_kind: 'custom_object', target_custom_object_id: restrictedId,
    }],
    custom_object_relationship: [{
      id: 'card-edge', tenant_id: tenantId, relationship_definition_id: cardDefinitionId,
      source_record_id: 'source-record', target_record_id: 'target-record', archived_at: null,
    }, {
      id: 'restricted-edge', tenant_id: tenantId, relationship_definition_id: directDefinitionId,
      source_record_id: 'target-record', target_record_id: 'restricted-record', archived_at: null,
    }],
  });
  const result = await createCustomObjectService({
    db, context: context(),
  }).listRelationships(objectId, {
    definitionId: cardDefinitionId,
    recordId: 'source-record',
    side: 'source',
  });
  assert.equal(result.data.length, 1);
  assert.deepEqual(result.data[0].related.relationship_columns, []);
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

test('relationship edge fields apply boolean defaults and enforce configured side metadata', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555555';
  const definition = {
    id: definitionId,
    tenant_id: tenantId,
    status: 'active',
    source_kind: 'custom_object',
    source_custom_object_id: objectId,
    target_kind: 'custom_object',
    target_custom_object_id: targetObjectId,
    cardinality: 'many_to_many',
    show_on_source: true,
    show_on_target: true,
    edit_from_source: true,
    edit_from_target: true,
    configuration: {
      relationship_fields: [{
        id: 'field-primary',
        key: 'is_primary',
        label: 'Primary',
        type: 'boolean',
        required: true,
        default_value: false,
        display_on_source: true,
        display_on_target: false,
        edit_from_source: true,
        edit_from_target: false,
      }],
    },
  };
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetObjectId, object_key: 'targets' }),
    ],
    custom_object_relationship_definition: [definition],
    custom_object_record: [{
      id: 'source-1', tenant_id: tenantId, custom_object_id: objectId,
      archived_at: null, data: {},
    }, {
      id: 'target-1', tenant_id: tenantId, custom_object_id: targetObjectId,
      archived_at: null, data: {},
    }],
    preference_field: [],
    custom_object_relationship: [],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  delete db.tables.custom_object_relationship_definition[0]
    .configuration.relationship_fields[0].default_value;
  await assert.rejects(() => service.createRelationship(objectId, {
    relationship_definition_id: definitionId,
    source_record_id: 'source-1',
    target_record_id: 'target-1',
    routed_side: 'source',
    routed_record_id: 'source-1',
  }), (error) => error.status === 400 && /must have a default/.test(error.message));
  db.tables.custom_object_relationship_definition[0]
    .configuration.relationship_fields[0].default_value = false;

  const created = await service.createRelationship(objectId, {
    relationship_definition_id: definitionId,
    source_record_id: 'source-1',
    target_record_id: 'target-1',
    routed_side: 'source',
    routed_record_id: 'source-1',
  });
  assert.deepEqual(created.field_values, { is_primary: false });
  db.tables.custom_object_relationship[0].archived_at = null;

  const updated = await service.updateRelationship(objectId, created.id, {
    routed_side: 'source',
    routed_record_id: 'source-1',
    field_values: { 'field-primary': true },
  });
  assert.deepEqual(updated.field_values, { is_primary: true });
  assert.equal(updated.relationship_fields[0].value, true);
  assert.ok(db.calls.some((call) => call.table === 'custom_object_relationship'
    && call.type === 'eq' && call.column === 'tenant_id' && call.value === tenantId));

  await assert.rejects(() => service.updateRelationship(objectId, created.id, {
    routed_side: 'source',
    routed_record_id: 'source-1',
    field_values: { forged: true },
  }), (error) => error.status === 400 && /Unknown relationship field/.test(error.message));
  await assert.rejects(() => service.updateRelationship(targetObjectId, created.id, {
    routed_side: 'target',
    routed_record_id: 'target-1',
    field_values: { is_primary: false },
  }), (error) => error.status === 403 && /cannot be edited/.test(error.message));

  const listed = await service.listRelationships(objectId, {
    definitionId,
    recordId: 'source-1',
    side: 'source',
  });
  assert.deepEqual(listed.data[0].field_values, { is_primary: true });
  assert.equal(listed.data[0].relationship_fields[0].editable, true);

  db.tables.custom_object_relationship[0].archived_at = '2026-01-01T00:00:00.000Z';
  await assert.rejects(() => service.updateRelationship(objectId, created.id, {
    routed_side: 'source',
    routed_record_id: 'source-1',
    field_values: { is_primary: false },
  }), (error) => error.status === 409 && /Archived relationship/.test(error.message));
});

test('legacy definition configuration fields are not interpreted as relationship fields', async () => {
  const targetObjectId = '44444444-4444-4444-8444-444444444444';
  const definitionId = '55555555-5555-4555-8555-555555555557';
  const db = mockDb({
    custom_object_definition: [
      object(),
      object({ id: targetObjectId, object_key: 'targets' }),
    ],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      source_kind: 'custom_object',
      source_custom_object_id: objectId,
      target_kind: 'custom_object',
      target_custom_object_id: targetObjectId,
      cardinality: 'many_to_many',
      show_on_source: true,
      show_on_target: true,
      edit_from_source: true,
      edit_from_target: true,
      configuration: { fields: [{ legacy: true }] },
    }],
    custom_object_record: [{
      id: 'source-1', tenant_id: tenantId, custom_object_id: objectId,
      archived_at: null, data: {},
    }, {
      id: 'target-1', tenant_id: tenantId, custom_object_id: targetObjectId,
      archived_at: null, data: {},
    }],
    preference_field: [],
    custom_object_relationship: [{
      id: 'edge-legacy-configuration',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'source-1',
      target_record_id: 'target-1',
      field_values: {},
      archived_at: null,
      created_at: '2026-09-05T00:00:00.000Z',
    }],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });

  const listed = await service.listRelationships(objectId, {
    definitionId,
    recordId: 'source-1',
    side: 'source',
  });

  assert.deepEqual(listed.data[0].relationship_fields, []);
  assert.deepEqual(listed.data[0].field_values, {});
});

test('core relationship edge field PATCH uses the derived tenant-scoped routed side', async () => {
  const definitionId = '55555555-5555-4555-8555-555555555556';
  const db = mockDb({
    member: [{ id: 'member-1', tenant_id: tenantId }],
    custom_object_definition: [object()],
    custom_object_relationship_definition: [{
      id: definitionId,
      tenant_id: tenantId,
      status: 'active',
      source_kind: 'member',
      source_custom_object_id: null,
      target_kind: 'custom_object',
      target_custom_object_id: objectId,
      cardinality: 'many_to_many',
      show_on_source: true,
      edit_from_source: true,
      configuration: {
        relationship_fields: [{
          id: 'verified-field',
          key: 'verified',
          label: 'Verified',
          type: 'boolean',
          required: true,
          default: false,
          display: true,
          edit_from_source: true,
          edit_from_target: false,
        }],
      },
    }],
    custom_object_record: [{
      id: 'record-1', tenant_id: tenantId, custom_object_id: objectId,
      archived_at: null, data: {},
    }],
    custom_object_relationship: [{
      id: 'edge-1',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: 'member-1',
      target_record_id: 'record-1',
      archived_at: null,
      field_values: { verified: false },
    }],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  const updated = await service.updateCoreRelationship(
    'member', 'member-1', 'edge-1', { field_values: { verified: true } },
  );
  assert.deepEqual(updated.field_values, { verified: true });
  assert.equal(updated.relationship_fields[0].editable, true);
  await assert.rejects(
    () => service.updateCoreRelationship(
      'member', 'another-member', 'edge-1', { field_values: { verified: false } },
    ),
    (error) => error.status === 404,
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
  assert.equal(picker.total, 0);
  assert.deepEqual(picker.data, []);
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
      target_kind: 'member', target_custom_object_id: null, cardinality: 'many_to_many',
      configuration: { picker_scope: { via_relationship_key: 'organisation', routed_core_field: 'organization_id' } },
      show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
    }, {
      id: parentDefinitionId, tenant_id: tenantId, relationship_key: 'organisation', status: 'active',
      is_required: true, source_kind: 'custom_object', source_custom_object_id: departmentObjectId,
      target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one',
    }],
    custom_object_record: [
      { id: 'dept-a', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, data: { name: 'A' } },
      { id: 'dept-c', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, data: { name: 'C' } },
      { id: 'dept-b', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, data: { name: 'B' } },
    ],
    member: [
      { id: 'member-a', tenant_id: tenantId, organization_id: 'org-a', first_name: 'A', last_name: 'Member' },
      { id: 'member-b', tenant_id: tenantId, organization_id: 'org-b', first_name: 'B', last_name: 'Member' },
    ],
    custom_object_relationship: [
      { id: 'parent-a', tenant_id: tenantId, relationship_definition_id: parentDefinitionId, source_record_id: 'dept-a', target_record_id: 'org-a', archived_at: null },
      { id: 'parent-c', tenant_id: tenantId, relationship_definition_id: parentDefinitionId, source_record_id: 'dept-c', target_record_id: 'org-a', archived_at: null },
      { id: 'parent-b', tenant_id: tenantId, relationship_definition_id: parentDefinitionId, source_record_id: 'dept-b', target_record_id: 'org-b', archived_at: null },
    ],
  };
  const legacySeed = structuredClone(seed);
  legacySeed.custom_object_relationship_definition[0].cardinality = 'one_to_many';
  const legacyPicker = await createCustomObjectService({
    db: mockDb(legacySeed),
    context: context(),
    isAdmin: true,
  }).coreEntityPicker('member', 'member-a', { definitionId: memberDefinitionId });
  assert.deepEqual(legacyPicker.data.map(row => row.id), ['dept-a', 'dept-c']);

  const db = mockDb(seed);
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });
  const fromMember = await service.coreEntityPicker('member', 'member-a', { definitionId: memberDefinitionId });
  assert.deepEqual(fromMember.data.map(row => row.id), ['dept-a', 'dept-c']);
  const fromDepartment = await service.entityPicker(departmentObjectId, {
    definitionId: memberDefinitionId, recordId: 'dept-a', side: 'source',
  });
  assert.deepEqual(fromDepartment.data.map(row => row.id), ['member-a']);
  await service.createCoreRelationship('member', 'member-a', {
    relationship_definition_id: memberDefinitionId, related_record_id: 'dept-a',
  });
  await service.createCoreRelationship('member', 'member-a', {
    relationship_definition_id: memberDefinitionId, related_record_id: 'dept-c',
  });
  assert.equal(db.tables.custom_object_relationship.filter(edge =>
    edge.relationship_definition_id === memberDefinitionId
      && edge.target_record_id === 'member-a').length, 2);
  await assert.rejects(
    () => service.createCoreRelationship('member', 'member-a', {
      relationship_definition_id: memberDefinitionId, related_record_id: 'dept-b',
    }),
    (error) => error.status === 400 && /picker scope/.test(error.message),
  );
});

test('v2 picker paths intersect through reusable relationship graph hops in both directions', async () => {
  const departmentObjectId = objectId;
  const assignmentObjectId = 'assignment-object';
  const memberDefinitionId = 'department-members-v2';
  const departmentOrganisationId = 'department-organisation-v2';
  const assignmentMemberId = 'assignment-member';
  const assignmentOrganisationId = 'assignment-organisation';
  const db = mockDb({
    custom_object_definition: [
      object({ id: departmentObjectId, object_key: 'org_department', primary_display_field_id: 'field-1' }),
      object({ id: assignmentObjectId, object_key: 'member_organisation_assignment' }),
    ],
    preference_field: [field({ custom_object_id: departmentObjectId, name: 'name', field_type: 'text' })],
    custom_object_relationship_definition: [{
      id: memberDefinitionId, tenant_id: tenantId, relationship_key: 'members', status: 'active',
      source_kind: 'custom_object', source_custom_object_id: departmentObjectId,
      target_kind: 'member', target_custom_object_id: null, cardinality: 'many_to_many',
      configuration: {
        picker_scope: {
          version: 2,
          match: 'intersects',
          source_path: [{
            relationship_definition_id: departmentOrganisationId,
            from_side: 'source',
          }],
          target_path: [{
            relationship_definition_id: assignmentMemberId,
            from_side: 'target',
          }, {
            relationship_definition_id: assignmentOrganisationId,
            from_side: 'source',
          }],
        },
      },
      show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
    }, {
      id: departmentOrganisationId, tenant_id: tenantId, relationship_key: 'organisation', status: 'active',
      source_kind: 'custom_object', source_custom_object_id: departmentObjectId,
      target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one',
    }, {
      id: assignmentMemberId, tenant_id: tenantId, relationship_key: 'assignment_member', status: 'active',
      source_kind: 'custom_object', source_custom_object_id: assignmentObjectId,
      target_kind: 'member', target_custom_object_id: null, cardinality: 'many_to_one',
    }, {
      id: assignmentOrganisationId, tenant_id: tenantId, relationship_key: 'assignment_organisation', status: 'active',
      source_kind: 'custom_object', source_custom_object_id: assignmentObjectId,
      target_kind: 'organization', target_custom_object_id: null, cardinality: 'many_to_one',
    }],
    custom_object_record: [
      { id: 'dept-a', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, created_at: '2026-01-01', data: { name: 'Alpha' } },
      { id: 'dept-b', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, created_at: '2026-01-02', data: { name: 'Beta' } },
      { id: 'dept-c', tenant_id: tenantId, custom_object_id: departmentObjectId, archived_at: null, created_at: '2026-01-03', data: { name: 'Charlie' } },
      { id: 'assignment-a', tenant_id: tenantId, custom_object_id: assignmentObjectId, archived_at: null },
      { id: 'assignment-c', tenant_id: tenantId, custom_object_id: assignmentObjectId, archived_at: null },
      { id: 'assignment-b', tenant_id: tenantId, custom_object_id: assignmentObjectId, archived_at: null },
      { id: 'assignment-archived', tenant_id: tenantId, custom_object_id: assignmentObjectId, archived_at: null },
    ],
    organization: [
      { id: 'org-a', tenant_id: tenantId, name: 'A' },
      { id: 'org-b', tenant_id: tenantId, name: 'B' },
      { id: 'org-c', tenant_id: tenantId, name: 'C' },
    ],
    member: [
      { id: 'member-a', tenant_id: tenantId, first_name: 'A', last_name: 'Member' },
      { id: 'member-b', tenant_id: tenantId, first_name: 'B', last_name: 'Member' },
    ],
    custom_object_relationship: [
      { id: 'dept-org-a', tenant_id: tenantId, relationship_definition_id: departmentOrganisationId, source_record_id: 'dept-a', target_record_id: 'org-a', archived_at: null },
      { id: 'dept-org-b', tenant_id: tenantId, relationship_definition_id: departmentOrganisationId, source_record_id: 'dept-b', target_record_id: 'org-b', archived_at: null },
      { id: 'dept-org-c', tenant_id: tenantId, relationship_definition_id: departmentOrganisationId, source_record_id: 'dept-c', target_record_id: 'org-c', archived_at: null },
      { id: 'assignment-member-a', tenant_id: tenantId, relationship_definition_id: assignmentMemberId, source_record_id: 'assignment-a', target_record_id: 'member-a', archived_at: null },
      { id: 'assignment-member-c', tenant_id: tenantId, relationship_definition_id: assignmentMemberId, source_record_id: 'assignment-c', target_record_id: 'member-a', archived_at: null },
      { id: 'assignment-member-b', tenant_id: tenantId, relationship_definition_id: assignmentMemberId, source_record_id: 'assignment-b', target_record_id: 'member-b', archived_at: null },
      { id: 'assignment-member-archived', tenant_id: tenantId, relationship_definition_id: assignmentMemberId, source_record_id: 'assignment-archived', target_record_id: 'member-a', archived_at: null },
      { id: 'assignment-org-a', tenant_id: tenantId, relationship_definition_id: assignmentOrganisationId, source_record_id: 'assignment-a', target_record_id: 'org-a', archived_at: null },
      { id: 'assignment-org-c', tenant_id: tenantId, relationship_definition_id: assignmentOrganisationId, source_record_id: 'assignment-c', target_record_id: 'org-c', archived_at: null },
      { id: 'assignment-org-b', tenant_id: tenantId, relationship_definition_id: assignmentOrganisationId, source_record_id: 'assignment-b', target_record_id: 'org-b', archived_at: null },
      { id: 'assignment-org-archived', tenant_id: tenantId, relationship_definition_id: assignmentOrganisationId, source_record_id: 'assignment-archived', target_record_id: 'org-b', archived_at: '2026-01-01' },
      { id: 'foreign-assignment', tenant_id: 'other-tenant', relationship_definition_id: assignmentOrganisationId, source_record_id: 'assignment-a', target_record_id: 'org-b', archived_at: null },
    ],
  });
  const service = createCustomObjectService({ db, context: context(), isAdmin: true });

  const firstPage = await service.coreEntityPicker('member', 'member-a', {
    definitionId: memberDefinitionId, page: '1', pageSize: '1',
  });
  assert.equal(firstPage.total, 2);
  assert.deepEqual(firstPage.data.map((row) => row.id), ['dept-a']);
  const secondPage = await service.coreEntityPicker('member', 'member-a', {
    definitionId: memberDefinitionId, page: '2', pageSize: '1',
  });
  assert.deepEqual(secondPage.data.map((row) => row.id), ['dept-c']);
  const searched = await service.coreEntityPicker('member', 'member-a', {
    definitionId: memberDefinitionId, search: 'Char',
  });
  assert.equal(searched.total, 1);
  assert.deepEqual(searched.data.map((row) => row.id), ['dept-c']);

  const fromDepartment = await service.entityPicker(departmentObjectId, {
    definitionId: memberDefinitionId, recordId: 'dept-b', side: 'source',
  });
  assert.deepEqual(fromDepartment.data.map((row) => row.id), ['member-b']);

  const noInitialPath = await service.initialRelationshipCandidates(departmentObjectId, {
    definitionId: memberDefinitionId,
    newRecordSide: 'source',
  });
  assert.equal(noInitialPath.total, 0);
  const initialWithProposedParent = await service.initialRelationshipCandidates(departmentObjectId, {
    definitionId: memberDefinitionId,
    newRecordSide: 'source',
    proposedRelationships: JSON.stringify([{
      relationship_definition_id: departmentOrganisationId,
      routed_side: 'source',
      related_record_id: 'org-a',
    }]),
  });
  assert.deepEqual(initialWithProposedParent.data.map((row) => row.id), ['member-a']);
  await assert.rejects(
    () => service.createRecordWithRelationships(departmentObjectId, {
      data: { name: 'New Department' },
      initial_relationships: [{
        relationship_definition_id: departmentOrganisationId,
        routed_side: 'source',
        related_record_id: 'org-a',
      }, {
        relationship_definition_id: memberDefinitionId,
        routed_side: 'source',
        related_record_id: 'member-b',
      }],
    }),
    (error) => error.status === 400 && /picker scope/.test(error.message),
  );

  await service.createCoreRelationship('member', 'member-a', {
    relationship_definition_id: memberDefinitionId,
    related_record_id: 'dept-c',
  });
  await assert.rejects(
    () => service.createRelationship(departmentObjectId, {
      relationship_definition_id: memberDefinitionId,
      routed_side: 'source',
      routed_record_id: 'dept-b',
      source_record_id: 'dept-b',
      target_record_id: 'member-a',
    }),
    (error) => error.status === 400 && /picker scope/.test(error.message),
  );

  db.tables.custom_object_relationship.find((edge) => edge.id === 'assignment-org-b').archived_at = '2026-02-01';
  const emptyAfterArchive = await service.entityPicker(departmentObjectId, {
    definitionId: memberDefinitionId, recordId: 'dept-b', side: 'source',
  });
  assert.equal(emptyAfterArchive.total, 0);
  assert.deepEqual(emptyAfterArchive.data, []);

  db.tables.custom_object_definition.find((item) => item.id === assignmentObjectId).status = 'archived';
  await assert.rejects(
    () => service.coreEntityPicker('member', 'member-a', {
      definitionId: memberDefinitionId,
    }),
    (error) => error.status === 409 && /endpoint is unavailable/.test(error.message),
  );
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

test('custom-routed pickers exclude linked and cardinality-exhausted candidates before pagination', async () => {
  const definitionId = 'picker-one-many';
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_record: [{ id: 'department-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null }],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'one_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'member', target_custom_object_id: null,
      show_on_source: true, edit_from_source: true,
    }],
    member: [
      { id: 'available-a', tenant_id: tenantId, first_name: 'A', last_name: 'Alpha' },
      { id: 'available-b', tenant_id: tenantId, first_name: 'B', last_name: 'Beta' },
      { id: 'linked-pair', tenant_id: tenantId, first_name: 'C', last_name: 'Charlie' },
      { id: 'exhausted', tenant_id: tenantId, first_name: 'D', last_name: 'Delta' },
    ],
    custom_object_relationship: [
      { tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'department-1', target_record_id: 'linked-pair', archived_at: null },
      { tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'department-2', target_record_id: 'exhausted', archived_at: null },
    ],
  });
  const result = await createCustomObjectService({ db, context: context(), isAdmin: true }).entityPicker(objectId, {
    definitionId, recordId: 'department-1', side: 'source', page: '2', pageSize: '1',
  });
  assert.equal(result.total, 2);
  assert.deepEqual(result.data.map((row) => row.id), ['available-b']);
});

test('many-to-many picker excludes only an existing pair, not candidates linked elsewhere', async () => {
  const definitionId = 'picker-many-many';
  const db = mockDb({
    custom_object_definition: [object()],
    custom_object_record: [{ id: 'department-1', tenant_id: tenantId, custom_object_id: objectId, archived_at: null }],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'many_to_many',
      source_kind: 'custom_object', source_custom_object_id: objectId,
      target_kind: 'organization', target_custom_object_id: null,
      show_on_source: true, edit_from_source: true,
    }],
    organization: [
      { id: 'linked-pair', tenant_id: tenantId, name: 'Alpha' },
      { id: 'linked-elsewhere', tenant_id: tenantId, name: 'Beta' },
      { id: 'available', tenant_id: tenantId, name: 'Gamma' },
    ],
    custom_object_relationship: [
      { tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'department-1', target_record_id: 'linked-pair', archived_at: null },
      { tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'department-2', target_record_id: 'linked-elsewhere', archived_at: null },
    ],
  });
  const result = await createCustomObjectService({ db, context: context(), isAdmin: true }).entityPicker(objectId, {
    definitionId, recordId: 'department-1', side: 'source',
  });
  assert.equal(result.total, 2);
  assert.deepEqual(result.data.map((row) => row.id), ['linked-elsewhere', 'available']);
});

test('core-routed pickers apply pair and candidate cardinality exclusions', async () => {
  const definitionId = 'core-picker-one-many';
  const db = mockDb({
    member: [{ id: 'member-1', tenant_id: tenantId, first_name: 'Ada' }],
    custom_object_definition: [object()],
    preference_field: [field({ id: 'name-field', name: 'name', field_type: 'text', is_required: false })],
    custom_object_relationship_definition: [{
      id: definitionId, tenant_id: tenantId, status: 'active', cardinality: 'one_to_many',
      source_kind: 'member', source_custom_object_id: null,
      target_kind: 'custom_object', target_custom_object_id: objectId,
      show_on_source: true, edit_from_source: true,
    }],
    custom_object_record: [
      { id: 'available-a', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, created_at: '2026-01-01', data: { name: 'A' } },
      { id: 'available-b', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, created_at: '2026-01-02', data: { name: 'B' } },
      { id: 'linked-pair', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, created_at: '2026-01-03', data: { name: 'C' } },
      { id: 'exhausted', tenant_id: tenantId, custom_object_id: objectId, archived_at: null, created_at: '2026-01-04', data: { name: 'D' } },
    ],
    custom_object_relationship: [
      { tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'member-1', target_record_id: 'linked-pair', archived_at: null },
      { tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'member-2', target_record_id: 'exhausted', archived_at: null },
    ],
  });
  const result = await createCustomObjectService({ db, context: context(), isAdmin: true }).coreEntityPicker('member', 'member-1', {
    definitionId, page: '2', pageSize: '1',
  });
  assert.equal(result.total, 2);
  assert.deepEqual(result.data.map((row) => row.id), ['available-b']);
});

test('pickers filter pairs and candidate cardinality on every cardinality and routed side', async () => {
  const sourceObjectId = objectId;
  const targetObjectId = 'picker-target-object';
  const cases = [
    ['one_to_one', 'source', true, true],
    ['one_to_one', 'target', true, true],
    ['one_to_many', 'source', true, false],
    ['one_to_many', 'target', false, true],
    ['many_to_one', 'source', false, true],
    ['many_to_one', 'target', true, false],
    ['many_to_many', 'source', false, false],
    ['many_to_many', 'target', false, false],
  ];

  for (const [cardinality, routedSide, candidateHasSingleEdge, routedHasSingleEdge] of cases) {
    const definitionId = `${cardinality}-${routedSide}`;
    const routedObjectId = routedSide === 'source' ? sourceObjectId : targetObjectId;
    const candidateObjectId = routedSide === 'source' ? targetObjectId : sourceObjectId;
    const candidateRows = ['linked-pair', 'shared', 'available-a', 'available-b'].map((id, index) => ({
      id,
      tenant_id: tenantId,
      custom_object_id: candidateObjectId,
      archived_at: null,
      created_at: `2026-01-0${index + 1}`,
    }));
    const db = mockDb({
      custom_object_definition: [
        object({ id: sourceObjectId }),
        object({ id: targetObjectId, object_key: 'picker_targets' }),
      ],
      custom_object_relationship_definition: [{
        id: definitionId, tenant_id: tenantId, status: 'active', cardinality,
        source_kind: 'custom_object', source_custom_object_id: sourceObjectId,
        target_kind: 'custom_object', target_custom_object_id: targetObjectId,
        show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
      }],
      custom_object_record: [
        {
          id: routedSide === 'source' ? 'source-route' : 'target-route',
          tenant_id: tenantId,
          custom_object_id: routedObjectId,
          archived_at: null,
        },
        ...candidateRows,
      ],
      custom_object_relationship: routedSide === 'source' ? [
        { id: 'edge-pair', tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'source-route', target_record_id: 'linked-pair', archived_at: null },
        { id: 'edge-shared', tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'source-other', target_record_id: 'shared', archived_at: null },
      ] : [
        { id: 'edge-pair', tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'linked-pair', target_record_id: 'target-route', archived_at: null },
        { id: 'edge-shared', tenant_id: tenantId, relationship_definition_id: definitionId, source_record_id: 'shared', target_record_id: 'target-other', archived_at: null },
      ],
    });
    const service = createCustomObjectService({ db, context: context(), isAdmin: true });
    const all = await service.entityPicker(routedObjectId, {
      definitionId,
      recordId: routedSide === 'source' ? 'source-route' : 'target-route',
      side: routedSide,
      pageSize: '10',
    });
    const pageTwo = await service.entityPicker(routedObjectId, {
      definitionId,
      recordId: routedSide === 'source' ? 'source-route' : 'target-route',
      side: routedSide,
      page: '2',
      pageSize: '1',
    });
    assert.equal(all.total, routedHasSingleEdge ? 0 : (candidateHasSingleEdge ? 2 : 3), `${cardinality}/${routedSide}`);
    assert.equal(all.data.some((row) => row.id === 'linked-pair'), false, `${cardinality}/${routedSide} pair`);
    assert.equal(
      all.data.some((row) => row.id === 'shared'),
      !routedHasSingleEdge && !candidateHasSingleEdge,
      `${cardinality}/${routedSide} shared`,
    );
    assert.deepEqual(
      pageTwo.data.map((row) => row.id),
      routedHasSingleEdge ? [] : [candidateHasSingleEdge ? 'available-b' : 'available-a'],
      `${cardinality}/${routedSide} page two`,
    );
  }
});

test('picker edge exclusion reads page two for every cardinality and routed side', async () => {
  const sourceObjectId = objectId;
  const targetObjectId = 'large-picker-target-object';
  const cases = [
    ['one_to_one', 'source', true, true],
    ['one_to_one', 'target', true, true],
    ['one_to_many', 'source', true, false],
    ['one_to_many', 'target', false, true],
    ['many_to_one', 'source', false, true],
    ['many_to_one', 'target', true, false],
    ['many_to_many', 'source', false, false],
    ['many_to_many', 'target', false, false],
  ];

  for (const [cardinality, routedSide, candidateHasSingleEdge, routedHasSingleEdge] of cases) {
    const definitionId = `large-${cardinality}-${routedSide}`;
    const routedObjectId = routedSide === 'source' ? sourceObjectId : targetObjectId;
    const candidateObjectId = routedSide === 'source' ? targetObjectId : sourceObjectId;
    const edges = Array.from({ length: 1000 }, (_, index) => ({
      id: `edge-${String(index).padStart(4, '0')}`,
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: `other-source-${index}`,
      target_record_id: `other-target-${index}`,
      archived_at: null,
    }));
    // A bounded candidate is exhausted by an edge elsewhere. An unlimited
    // candidate instead relies on the duplicate-pair rule. In both cases this
    // is the first relevant edge and is deliberately on page two.
    edges.push({
      id: 'edge-1000',
      tenant_id: tenantId,
      relationship_definition_id: definitionId,
      source_record_id: routedSide === 'source'
        ? (routedHasSingleEdge || !candidateHasSingleEdge ? 'source-route' : 'different-source')
        : 'excluded-on-second-page',
      target_record_id: routedSide === 'target'
        ? (routedHasSingleEdge || !candidateHasSingleEdge ? 'target-route' : 'different-target')
        : 'excluded-on-second-page',
      archived_at: null,
    });
    const db = mockDb({
      custom_object_definition: [
        object({ id: sourceObjectId }),
        object({ id: targetObjectId, object_key: 'large_picker_targets' }),
      ],
      custom_object_relationship_definition: [{
        id: definitionId, tenant_id: tenantId, status: 'active', cardinality,
        source_kind: 'custom_object', source_custom_object_id: sourceObjectId,
        target_kind: 'custom_object', target_custom_object_id: targetObjectId,
        show_on_source: true, show_on_target: true, edit_from_source: true, edit_from_target: true,
      }],
      custom_object_record: [
        {
          id: routedSide === 'source' ? 'source-route' : 'target-route',
          tenant_id: tenantId, custom_object_id: routedObjectId, archived_at: null,
        },
        {
          id: 'excluded-on-second-page',
          tenant_id: tenantId, custom_object_id: candidateObjectId, archived_at: null,
        },
        {
          id: 'available',
          tenant_id: tenantId, custom_object_id: candidateObjectId, archived_at: null,
        },
      ],
      custom_object_relationship: edges,
    });
    const result = await createCustomObjectService({ db, context: context(), isAdmin: true }).entityPicker(routedObjectId, {
      definitionId,
      recordId: routedSide === 'source' ? 'source-route' : 'target-route',
      side: routedSide,
    });
    assert.equal(result.total, routedHasSingleEdge ? 0 : 1, `${cardinality}/${routedSide}`);
    assert.deepEqual(result.data.map((row) => row.id), routedHasSingleEdge ? [] : ['available'], `${cardinality}/${routedSide}`);
    assert.ok(db.calls.some((call) => call.table === 'custom_object_relationship'
      && call.type === 'order' && call.column === 'id'), `${cardinality}/${routedSide}`);
  }
});