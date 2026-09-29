import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommunicationCategoriesHandler } from './communication-categories.js';

function endpoint({ categories = [], roles = [], failures = {} } = {}) {
  const queries = [];
  const rows = {
    communication_category: categories,
    communication_category_role: roles,
  };
  const database = {
    from(table) {
      const query = { table, filters: [], selection: null, ordering: null };
      queries.push(query);
      const builder = {
        select(columns) { query.selection = columns; return builder; },
        eq(column, value) { query.filters.push(['eq', column, value]); return builder; },
        in(column, values) { query.filters.push(['in', column, values]); return builder; },
        order(column, options) {
          query.ordering = [column, options];
          return builder;
        },
        then(resolve, reject) {
          const error = failures[table];
          if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);
          let result = rows[table].filter(row => query.filters.every(([operator, column, value]) => (
            operator === 'eq' ? row[column] === value : value.includes(row[column])
          )));
          if (query.ordering) {
            const [column, { ascending }] = query.ordering;
            result = [...result].sort((a, b) => (
              ascending ? a[column] - b[column] : b[column] - a[column]
            ));
          }
          const selected = query.selection.split(',').map(column => column.trim());
          return Promise.resolve({
            data: result.map(row => Object.fromEntries(selected.map(column => [column, row[column]]))),
            error: null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const handler = createCommunicationCategoriesHandler({
    env: { SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_KEY: 'test-key' },
    createDatabaseClient: () => database,
    resolveTenant: async () => ({ id: 'tenant-1' }),
  });
  async function get() {
    const req = { method: 'GET' }; // No authentication or member role: public visitor.
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler(req, res);
    return res;
  }
  return { get, queries };
}

test('anonymous category endpoint includes public role-scoped categories, but not private, inactive or other-tenant categories', async () => {
  const visible = { id: 'scoped', name: 'Role scoped', description: 'For a role', is_public: true, member_enabled: true, is_active: true, tenant_id: 'tenant-1', display_order: 2 };
  const open = { ...visible, id: 'open', name: 'Open', display_order: 1 };
  const { get, queries } = endpoint({
    categories: [
      visible,
      open,
      { ...visible, id: 'private', is_public: false },
      { ...visible, id: 'inactive', is_active: false },
      { ...visible, id: 'foreign', tenant_id: 'tenant-2' },
    ],
    roles: [
      { tenant_id: 'tenant-1', category_id: 'scoped', role_id: 'role-1' },
      { tenant_id: 'tenant-1', category_id: 'scoped', role_id: 'role-2' },
      { tenant_id: 'tenant-2', category_id: 'scoped', role_id: 'foreign-role' },
      { tenant_id: 'tenant-1', category_id: 'private', role_id: 'private-role' },
    ],
  });

  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [
    { id: 'open', name: 'Open', description: 'For a role', is_public: true, member_enabled: true, role_ids: [] },
    { id: 'scoped', name: 'Role scoped', description: 'For a role', is_public: true, member_enabled: true, role_ids: ['role-1', 'role-2'] },
  ]);
  assert.deepEqual(queries.map(query => query.table), ['communication_category', 'communication_category_role']);
  assert.deepEqual(queries[0].filters, [
    ['eq', 'is_active', true],
    ['eq', 'is_public', true],
    ['eq', 'tenant_id', 'tenant-1'],
  ]);
  assert.deepEqual(queries[1].filters, [
    ['eq', 'tenant_id', 'tenant-1'],
    ['in', 'category_id', ['open', 'scoped']],
  ]);
});

test('category query failure returns an error, not an empty category list', async () => {
  const { get, queries } = endpoint({
    failures: { communication_category: { message: 'categories unavailable' } },
  });
  const res = await get();
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'categories unavailable' });
  assert.deepEqual(queries.map(query => query.table), ['communication_category']);
});

test('role query failure returns an error, not categories without role restrictions', async () => {
  const { get, queries } = endpoint({
    categories: [{ id: 'scoped', tenant_id: 'tenant-1', is_active: true, is_public: true, display_order: 1 }],
    failures: { communication_category_role: { message: 'roles unavailable' } },
  });
  const res = await get();
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'roles unavailable' });
  assert.deepEqual(queries.map(query => query.table), ['communication_category', 'communication_category_role']);
});