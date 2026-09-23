import assert from 'node:assert/strict';
import test from 'node:test';
import { handleMemberEmailHistory } from './[memberId].js';

function responseRecorder() {
  return {
    statusCode: 200, body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function databaseFixture(member) {
  const operations = [];
  return {
    operations,
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        order() { return query; },
        in() { return query; },
        maybeSingle() {
          operations.push({ table, filters: [...filters] });
          return Promise.resolve({ data: member, error: null });
        },
        limit() {
          operations.push({ table, filters: [...filters] });
          return Promise.resolve({ data: [], error: null });
        },
      };
      return query;
    },
  };
}

async function invoke({
  member = { id: 'member-a', email: 'member@example.com', login_enabled: true },
  query = {},
  headers = { 'x-tenant-id': 'tenant-a' },
  admin = true,
} = {}) {
  const database = databaseFixture(member);
  const res = responseRecorder();
  await handleMemberEmailHistory(
    { method: 'GET', headers, query: { memberId: 'member-a', ...query } },
    res,
    {
      database,
      getTenantContext: async () => ({ isAuthenticated: true, tenantId: 'tenant-a' }),
      hasAdminAccess: async () => admin,
      getAgentEmailsForTenant: async () => new Set(),
      getOrgMapForTenant: async () => new Map(),
    },
  );
  return { database, res };
}

test('history access is admin gated and tenant scoped by the client tenant header', async () => {
  for (const args of [{ admin: false }, { headers: { 'x-tenant-id': 'tenant-b' } }, { headers: {} }]) {
    const { res, database } = await invoke(args);
    assert.equal(res.statusCode, 403);
    assert.equal(database.operations.length, 0);
  }
  const { res, database } = await invoke();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(database.operations[0], {
    table: 'member',
    filters: [['id', 'member-a'], ['tenant_id', 'tenant-a']],
  });
  assert.deepEqual(database.operations[1], {
    table: 'member_email',
    filters: [['tenant_id', 'tenant-a'], ['member_id', 'member-a']],
  });
});

test('history rejects anonymized members before reading email rows', async () => {
  const { res, database } = await invoke({
    member: { id: 'member-a', email: 'deleted_x@deleted.local', login_enabled: false },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(database.operations.some(op => op.table === 'member_email'), false);
});

test('history remains available for legitimate login-disabled contacts', async () => {
  const { res } = await invoke({
    member: { id: 'member-a', email: 'member@example.com', login_enabled: false },
  });
  assert.equal(res.statusCode, 200);
});