import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from './index.js';

function fakeSupabase(rows) {
  return {
    from() {
      const query = {
        select() { return query; },
        eq() { return query; },
        is() { return query; },
        order() { return query; },
        range(start, end) {
          return Promise.resolve({
            data: rows.slice(start, end + 1),
            count: rows.length,
            error: null,
          });
        },
        then(resolve, reject) {
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const actor = {
  tenantId: 'tenant-1',
  memberId: 'member-1',
  permissions: { view: true, manageShared: true, managePersonal: true },
};

test('Canvas widget discovery defaults to 50 and returns shared palette pagination', async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `shared-${index + 1}`,
    scope: 'shared',
    tenant_id: 'tenant-1',
  }));
  const handler = createHandler({
    supabase: fakeSupabase(rows),
    getDashboardActor: async () => actor,
    getDashboardWidgetPalette: async () => [{ key: 'default', color: '#fff' }],
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { embed: 'canvas' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.shared, rows);
  assert.equal(res.body.personal, undefined);
  assert.deepEqual(res.body.palette, [{ key: 'default', color: '#fff' }]);
  assert.deepEqual(res.body.pagination, {
    page: 1,
    pageSize: 50,
    total: 3,
    pages: 1,
    hasMore: false,
  });
});

test('Canvas widget discovery returns only the requested page and follows page metadata', async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `shared-${index + 1}`,
    scope: 'shared',
    tenant_id: 'tenant-1',
  }));
  const handler = createHandler({
    supabase: fakeSupabase(rows),
    getDashboardActor: async () => actor,
    getDashboardWidgetPalette: async () => [],
  });
  const res = response();

  await handler({
    method: 'GET',
    query: { embed: 'canvas', page: '2', pageSize: '2' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.shared, [rows[2]]);
  assert.deepEqual(res.body.pagination, {
    page: 2,
    pageSize: 2,
    total: 3,
    pages: 2,
    hasMore: false,
  });
});