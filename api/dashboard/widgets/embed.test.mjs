import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler as createDiscoveryHandler } from './index.js';
import { createHandler as createDetailHandler } from './[id].js';
import { createHandler as createDataHandler } from './[id]/data.js';
import { createHandler as createDrilldownHandler } from './[id]/drilldown.js';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const ACTOR = {
  tenantId: TENANT,
  memberId: 'member-1',
  permissions: {
    view: true,
    manageShared: true,
    managePersonal: true,
  },
};

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
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

/**
 * Small Supabase query double that intentionally applies every tenant/scope
 * predicate. This makes a cross-tenant test fail if an endpoint ever drops
 * tenantFilter, rather than merely asserting the eventual 404.
 */
function database(rows) {
  const queries = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.predicates = [];
      this.orders = [];
      this.rangeValue = null;
    }

    select(...args) {
      this.selectArgs = args;
      return this;
    }

    eq(column, value) {
      this.predicates.push(row => row[column] === value);
      return this;
    }

    is(column, value) {
      this.predicates.push(row => row[column] === value);
      return this;
    }

    order(column, options = {}) {
      this.orders.push({ column, ascending: options.ascending !== false });
      return this;
    }

    range(from, to) {
      this.rangeValue = { from, to };
      return this;
    }

    limit(value) {
      this.limitValue = value;
      return this;
    }

    matchingRows() {
      let result = rows
        .filter(row => this.predicates.every(predicate => predicate(row)))
        .map(row => structuredClone(row));
      for (let index = this.orders.length - 1; index >= 0; index -= 1) {
        const { column, ascending } = this.orders[index];
        result.sort((left, right) => {
          if (left[column] === right[column]) return 0;
          const comparison = left[column] < right[column] ? -1 : 1;
          return ascending ? comparison : -comparison;
        });
      }
      const total = result.length;
      if (this.rangeValue) {
        result = result.slice(this.rangeValue.from, this.rangeValue.to + 1);
      }
      if (this.limitValue !== undefined) result = result.slice(0, this.limitValue);
      return { result, total };
    }

    single() {
      const { result } = this.matchingRows();
      if (result.length !== 1) {
        return Promise.resolve({
          data: null,
          error: { message: result.length ? 'Multiple rows' : 'Not found' },
        });
      }
      return Promise.resolve({ data: result[0], error: null });
    }

    then(resolve, reject) {
      const { result, total } = this.matchingRows();
      return Promise.resolve({ data: result, count: total, error: null })
        .then(resolve, reject);
    }
  }

  return {
    queries,
    from(table) {
      const query = new Query(table);
      queries.push(query);
      return query;
    },
  };
}

function actor(overrides = {}) {
  return {
    ...ACTOR,
    ...overrides,
    permissions: { ...ACTOR.permissions, ...(overrides.permissions || {}) },
  };
}

function widget(overrides = {}) {
  return {
    id: 'widget-shared',
    tenant_id: TENANT,
    scope: 'shared',
    owner_member_id: null,
    title: 'Shared widget',
    widget_type: 'bar',
    display_order: 0,
    config: {
      source: 'organization',
      groupBy: 'name',
      clickThrough: true,
    },
    ...overrides,
  };
}

function embedRequest(method, id, extras = {}) {
  return {
    method,
    query: { ...(id ? { id } : {}), embed: 'canvas', ...(extras.query || {}) },
    body: extras.body || {},
  };
}

test('discovery enforces auth, returns only shared tenant widgets, and paginates stably', async () => {
  const rows = [
    widget({ id: 'z-shared', display_order: 0 }),
    widget({ id: 'a-shared', display_order: 0 }),
    widget({ id: 'personal', scope: 'personal', owner_member_id: 'member-1' }),
    widget({ id: 'other-tenant', tenant_id: OTHER_TENANT }),
  ];
  const db = database(rows);
  const handler = createDiscoveryHandler({
    supabase: db,
    getDashboardActor: async () => actor(),
    getDashboardWidgetPalette: async () => [{ key: 'default', color: '#123456' }],
  });

  const first = response();
  await handler({
    method: 'GET',
    query: { embed: 'canvas', page: '1', pageSize: '1' },
  }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(first.body.shared.map(row => row.id), ['a-shared']);
  assert.deepEqual(first.body.palette, [{ key: 'default', color: '#123456' }]);
  assert.deepEqual(first.body.pagination, {
    page: 1,
    pageSize: 1,
    total: 2,
    pages: 2,
    hasMore: true,
  });
  assert.equal(first.body.personal, undefined);
  assert.deepEqual(db.queries[0].orders, [
    { column: 'display_order', ascending: true },
    { column: 'id', ascending: true },
  ]);

  const second = response();
  await handler({
    method: 'GET',
    query: { embed: 'canvas', page: '2', pageSize: '1' },
  }, second);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body.shared.map(row => row.id), ['z-shared']);

  const anonymous = response();
  const anonymousHandler = createDiscoveryHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => null,
    getDashboardWidgetPalette: async () => [],
  });
  await anonymousHandler({ method: 'GET', query: { embed: 'canvas' } }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers['Cache-Control'], 'private, no-store');

  const denied = response();
  const deniedHandler = createDiscoveryHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => actor({ permissions: { view: false } }),
    getDashboardWidgetPalette: async () => [],
  });
  await deniedHandler({ method: 'GET', query: { embed: 'canvas' } }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['Cache-Control'], 'private, no-store');
});

test('GET widget detail denies personal and cross-tenant references but serves shared widgets', async () => {
  const rows = [
    widget({ id: 'personal', scope: 'personal', owner_member_id: 'member-1' }),
    widget({ id: 'other-tenant', tenant_id: OTHER_TENANT }),
    widget({ id: 'shared-ok' }),
  ];
  const makeHandler = () => createDetailHandler({
    supabase: database(rows),
    getDashboardActor: async () => actor(),
  });

  for (const id of ['personal', 'other-tenant']) {
    const res = response();
    await makeHandler()(embedRequest('GET', id), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
  }

  const success = response();
  await makeHandler()(embedRequest('GET', 'shared-ok'), success);
  assert.equal(success.statusCode, 200);
  assert.equal(success.body.widget.id, 'shared-ok');
  assert.equal(success.headers['Cache-Control'], 'private, no-store');

  const anonymous = response();
  await createDetailHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => null,
  })(embedRequest('GET', 'shared-ok'), anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers['Cache-Control'], 'private, no-store');

  const denied = response();
  await createDetailHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => actor({ permissions: { view: false } }),
  })(embedRequest('GET', 'shared-ok'), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['Cache-Control'], 'private, no-store');
});

test('POST data denies private references and sets no-store before aggregation', async () => {
  const rows = [
    widget({ id: 'personal', scope: 'personal', owner_member_id: 'member-1' }),
    widget({ id: 'other-tenant', tenant_id: OTHER_TENANT }),
    widget({ id: 'shared-ok' }),
  ];
  let aggregationCalls = 0;
  let aggregationCacheControl;
  const res = response();
  const handler = createDataHandler({
    supabase: database(rows),
    getDashboardActor: async () => actor(),
    runWidgetConfig: async (_config, tenantId, options) => {
      aggregationCalls += 1;
      aggregationCacheControl = res.headers['Cache-Control'];
      assert.equal(tenantId, TENANT);
      assert.equal(options.collectRowIds, undefined);
      return { type: 'group', rows: [{ key: 'All', value: 1 }] };
    },
  });

  await handler(embedRequest('POST', 'personal'), response());
  await handler(embedRequest('POST', 'other-tenant'), response());
  assert.equal(aggregationCalls, 0);

  await handler(embedRequest('POST', 'shared-ok'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(aggregationCalls, 1);
  assert.equal(aggregationCacheControl, 'private, no-store');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');

  const anonymous = response();
  await createDataHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => null,
    runWidgetConfig: async () => {
      throw new Error('aggregation must not run');
    },
  })(embedRequest('POST', 'shared-ok'), anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers['Cache-Control'], 'private, no-store');

  const denied = response();
  await createDataHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => actor({ permissions: { view: false } }),
    runWidgetConfig: async () => {
      throw new Error('aggregation must not run');
    },
  })(embedRequest('POST', 'shared-ok'), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['Cache-Control'], 'private, no-store');
});

test('POST drilldown denies private references and serves shared data after no-store', async () => {
  const rows = [
    widget({ id: 'personal', scope: 'personal', owner_member_id: 'member-1' }),
    widget({ id: 'other-tenant', tenant_id: OTHER_TENANT }),
    widget({ id: 'shared-ok' }),
  ];
  let aggregationCalls = 0;
  let aggregationCacheControl;
  const res = response();
  const handler = createDrilldownHandler({
    supabase: database(rows),
    getDashboardActor: async () => actor(),
    getSourceDef: () => ({ table: 'organization' }),
    runWidgetConfig: async (_config, tenantId, options) => {
      aggregationCalls += 1;
      aggregationCacheControl = res.headers['Cache-Control'];
      assert.equal(tenantId, TENANT);
      assert.equal(options.collectRowIds, true);
      return { rows: [{ key: 'All', rowIds: ['org-1', 'org-2'] }] };
    },
  });

  await handler(embedRequest('POST', 'personal', { body: { key: 'All' } }), response());
  await handler(embedRequest('POST', 'other-tenant', { body: { key: 'All' } }), response());
  assert.equal(aggregationCalls, 0);

  await handler(embedRequest('POST', 'shared-ok', { body: { key: 'All' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    entity: 'organization',
    key: 'All',
    ids: ['org-1', 'org-2'],
    total: 2,
    truncated: false,
  });
  assert.equal(aggregationCalls, 1);
  assert.equal(aggregationCacheControl, 'private, no-store');

  const anonymous = response();
  await createDrilldownHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => null,
    getSourceDef: () => ({ table: 'organization' }),
    runWidgetConfig: async () => {
      throw new Error('aggregation must not run');
    },
  })(embedRequest('POST', 'shared-ok', { body: { key: 'All' } }), anonymous);
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.headers['Cache-Control'], 'private, no-store');

  const denied = response();
  await createDrilldownHandler({
    supabase: { from() { throw new Error('database must not be queried'); } },
    getDashboardActor: async () => actor({ permissions: { view: false } }),
    getSourceDef: () => ({ table: 'organization' }),
    runWidgetConfig: async () => {
      throw new Error('aggregation must not run');
    },
  })(embedRequest('POST', 'shared-ok', { body: { key: 'All' } }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['Cache-Control'], 'private, no-store');
});