import assert from 'node:assert/strict';
import test from 'node:test';
import { validateFormRowSourceConfiguration } from './formRowSourceConfiguration.js';

const id = suffix => `20000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

test('form row source guard rejects malformed persisted sources before metadata access', async () => {
  let metadataCalls = 0;
  const result = await validateFormRowSourceConfiguration({
    db: { from() { metadataCalls += 1; throw new Error('must not query'); } },
    tenantId: 'tenant-1',
    form: {
      fields: [{
        id: id(1),
        type: 'repeatable_rows',
        children: [{
          id: id(2),
          type: 'relationship_dropdown',
          option_source: {
            version: 1,
            kind: 'records',
            custom_object_id: 'not-a-uuid',
            primary_display_field_id: id(3),
            filters: [],
          },
        }],
      }],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(metadataCalls, 0);
});

test('form row source guard checks every configured child against authoritative metadata', async () => {
  const checked = [];
  const source = {
    version: 1,
    kind: 'records',
    custom_object_id: id(3),
    primary_display_field_id: id(4),
    filters: [],
  };
  const form = {
    fields: [{
      id: id(1),
      type: 'repeatable_rows',
      children: [
        { id: id(2), type: 'relationship_dropdown', option_source: source },
        { id: id(5), type: 'text' },
      ],
    }],
  };
  const result = await validateFormRowSourceConfiguration({
    tenantId: 'tenant-1',
    form,
    relationshipService: {
      async validatePersistedRowSource(input) { checked.push(input); },
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(checked, [{
    form,
    fieldId: id(2),
    containerFieldId: id(1),
  }]);
});

test('form row source guard rejects sources outside repeatable rows', async () => {
  const result = await validateFormRowSourceConfiguration({
    db: {},
    tenantId: 'tenant-1',
    form: {
      fields: [{
        id: id(1),
        type: 'relationship_dropdown',
        option_source: {
          version: 1,
          kind: 'records',
          custom_object_id: id(2),
          primary_display_field_id: id(3),
          filters: [],
        },
      }],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /only available inside repeatable rows/);
});

test('form row source guard requires author configuration authority', async () => {
  const result = await validateFormRowSourceConfiguration({
    db: {},
    tenantId: 'tenant-1',
    canConfigure: false,
    form: {
      fields: [{
        id: id(1),
        type: 'repeatable_rows',
        children: [{
          id: id(2),
          type: 'relationship_dropdown',
          option_source: {
            version: 1,
            kind: 'records',
            custom_object_id: id(3),
            primary_display_field_id: id(4),
            filters: [],
          },
        }],
      }],
    },
  });
  assert.equal(result.status, 403);
  assert.equal(result.code, 'ROW_OPTION_SOURCE_FORBIDDEN');
});

test('form row source guard enforces role record grants and explicit field denials', async () => {
  const source = {
    version: 1,
    kind: 'records',
    custom_object_id: id(3),
    primary_display_field_id: id(4),
    filters: [],
  };
  const form = {
    fields: [{
      id: id(1),
      type: 'repeatable_rows',
      children: [{ id: id(2), type: 'relationship_dropdown', option_source: source }],
    }],
  };
  function permissionDb({ grant = true, denied = false }) {
    const tables = {
      custom_object_role_permission: grant ? [{
        tenant_id: 'tenant-1', custom_object_id: id(3), role_id: 'role-1',
        can_view_records: true,
      }] : [],
      custom_object_field_role_permission: denied ? [{
        tenant_id: 'tenant-1', custom_object_id: id(3), role_id: 'role-1',
        field_id: id(4), access_level: 'none',
      }] : [],
    };
    return {
      from(table) {
        const filters = [];
        const query = {
          select() { return this; },
          eq(column, value) { filters.push(row => row[column] === value); return this; },
          in(column, values) { filters.push(row => values.includes(row[column])); return this; },
          async maybeSingle() {
            return {
              data: (tables[table] || []).find(row => filters.every(filter => filter(row))) || null,
              error: null,
            };
          },
          then(resolve, reject) {
            return Promise.resolve({
              data: (tables[table] || []).filter(row => filters.every(filter => filter(row))),
              error: null,
            }).then(resolve, reject);
          },
        };
        return query;
      },
    };
  }
  for (const db of [
    permissionDb({ grant: false }),
    permissionDb({ denied: true }),
  ]) {
    const result = await validateFormRowSourceConfiguration({
      db,
      tenantId: 'tenant-1',
      canConfigure: true,
      isTenantUser: false,
      authorRoleId: 'role-1',
      form,
      relationshipService: { async validatePersistedRowSource() {} },
    });
    assert.equal(result.status, 403);
    assert.match(result.error, /record and field read access/);
  }
  const allowed = await validateFormRowSourceConfiguration({
    db: permissionDb({}),
    tenantId: 'tenant-1',
    canConfigure: true,
    isTenantUser: false,
    authorRoleId: 'role-1',
    form,
    relationshipService: { async validatePersistedRowSource() {} },
  });
  assert.deepEqual(allowed, { ok: true });
});

test('role field restriction cache covers later sources on the same object', async () => {
  const first = {
    version: 1, kind: 'records', custom_object_id: id(3),
    primary_display_field_id: id(4), filters: [],
  };
  const second = {
    version: 1, kind: 'records', custom_object_id: id(3),
    primary_display_field_id: id(5), filters: [],
  };
  const rows = {
    custom_object_role_permission: [{
      tenant_id: 'tenant-1', custom_object_id: id(3), role_id: 'role-1',
      can_view_records: true,
    }],
    custom_object_field_role_permission: [{
      tenant_id: 'tenant-1', custom_object_id: id(3), role_id: 'role-1',
      field_id: id(5), access_level: 'none',
    }],
  };
  const db = {
    from(table) {
      const filters = [];
      return {
        select() { return this; },
        eq(column, value) { filters.push(row => row[column] === value); return this; },
        async maybeSingle() {
          return { data: (rows[table] || []).find(row => filters.every(fn => fn(row))) || null, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({
            data: (rows[table] || []).filter(row => filters.every(fn => fn(row))),
            error: null,
          }).then(resolve, reject);
        },
      };
    },
  };
  const result = await validateFormRowSourceConfiguration({
    db,
    tenantId: 'tenant-1',
    canConfigure: true,
    isTenantUser: false,
    authorRoleId: 'role-1',
    form: {
      fields: [{
        id: id(1),
        type: 'repeatable_rows',
        children: [
          { id: id(2), type: 'relationship_dropdown', option_source: first },
          { id: id(6), type: 'relationship_dropdown', option_source: second },
        ],
      }],
    },
    relationshipService: { async validatePersistedRowSource() {} },
  });
  assert.equal(result.status, 403);
});