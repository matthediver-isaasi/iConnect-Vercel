import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './filters.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function handler(options = {}) {
  const calls = [];
  const service = {
    async metadata(input) {
      calls.push(['metadata', input]);
      return { fields: [{ key: 'custom:allowed' }], ...(input.settings ? { overrides: {} } : {}) };
    },
    async search(input) {
      calls.push(['search', input]);
      return { organizations: [], total: 0, page: 1, pageSize: 12, fields: [] };
    },
    async options(input) {
      calls.push(['options', input]);
      return {
        options: [], total: 0, page: 1, pageSize: 50,
        selectedOptions: [], unavailableSelected: [],
      };
    },
  };
  return {
    calls,
    run: createHandler({
      db: options.db || {},
      getTenantContext: async () => options.context || ({
        isAuthenticated: true, tenantId: 'tenant-1', roleId: 'role-1',
      }),
      hasFeatureAccess: async (_role, feature) => options.features?.includes(feature) ?? true,
      hasAdminAccess: async () => false,
      resolveMemberExclusions: async ({ memberExcludedFeatures = [] }) =>
        memberExcludedFeatures,
      settingsCheck: options.settingsCheck,
      createOrganisationDirectoryFilters: () => service,
    }),
  };
}

test('GET and POST enforce authentication and directory feature access', async () => {
  const unauthenticated = handler({ context: { isAuthenticated: false } });
  let res = response();
  await unauthenticated.run({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401);

  const denied = handler({ features: [] });
  res = response();
  await denied.run({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 403);

  const allowed = handler();
  res = response();
  const body = { filters: {}, page: 1, pageSize: 12 };
  await allowed.run({ method: 'POST', query: {}, headers: {}, body }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(allowed.calls, [['search', body]]);
});

test('POST action options routes the exact request body to the options service', async () => {
  const allowed = handler();
  const body = {
    action: 'options',
    fieldKey: 'custom:allowed',
    search: '',
    page: 1,
    pageSize: 50,
    selected: [],
  };
  const res = response();
  await allowed.run({ method: 'POST', query: {}, headers: {}, body }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(allowed.calls, [['options', body]]);
  assert.deepEqual(res.body, {
    options: [], total: 0, page: 1, pageSize: 50,
    selectedOptions: [], unavailableSelected: [],
  });
});

test('settings mode uses the settings feature independently and rejects embed requests', async () => {
  const settingsOnly = handler({
    features: ['membership.organisation-directory-settings'],
    settingsCheck: async () => true,
  });
  let res = response();
  await settingsOnly.run({
    method: 'GET', query: { settings: 'true' }, headers: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { fields: [{ key: 'custom:allowed' }], overrides: {} });

  res = response();
  await settingsOnly.run({
    method: 'GET', query: { settings: 'true', embed: 'true' }, headers: {},
  }, res);
  assert.equal(res.statusCode, 403);

  const denied = handler({ features: [], settingsCheck: async () => false });
  res = response();
  await denied.run({
    method: 'PUT', query: { settings: 'true' }, headers: {},
  }, res);
  assert.equal(res.statusCode, 403);
});

test('hierarchical member exclusions deny direct view, search, and settings requests', async () => {
  const excludedView = handler({
    context: {
      isAuthenticated: true,
      tenantId: 'tenant-1',
      roleId: 'role-1',
      memberExcludedFeatures: ['membership'],
    },
  });
  for (const method of ['GET', 'POST']) {
    const res = response();
    await excludedView.run({
      method, query: {}, headers: {}, body: { filters: {} },
    }, res);
    assert.equal(res.statusCode, 403);
  }
  const excludedSettings = handler({
    settingsCheck: async () => true,
    context: {
      isAuthenticated: true,
      tenantId: 'tenant-1',
      roleId: 'role-1',
      memberExcludedFeatures: ['membership.organisation-directory-settings'],
    },
  });
  for (const method of ['GET', 'PUT']) {
    const res = response();
    await excludedSettings.run({
      method, query: { settings: 'true' }, headers: {}, body: { changes: {} },
    }, res);
    assert.equal(res.statusCode, 403);
  }
});

test('authorized settings PUT validates against settings metadata and persists through the dedicated path', async () => {
  const rows = [];
  class Query {
    constructor(action = 'read', value = null) {
      this.action = action;
      this.value = value;
      this.filters = [];
    }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    limit() { return this; }
    then(resolve, reject) {
      let data = rows.filter((row) => this.filters.every(([key, value]) => row[key] === value));
      if (this.action === 'insert') {
        rows.push({ id: 'setting-1', ...this.value });
        data = [{ id: 'setting-1' }];
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  }
  const db = {
    from() {
      const query = new Query();
      query.insert = (value) => new Query('insert', value);
      return query;
    },
  };
  const authorized = handler({ db, settingsCheck: async () => true });
  let res = response();
  await authorized.run({
    method: 'PUT',
    query: { settings: 'true' },
    headers: {},
    body: { changes: { 'custom:allowed': true } },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { overrides: { 'custom:allowed': true } });
  assert.equal(rows[0].tenant_id, 'tenant-1');

  res = response();
  await authorized.run({
    method: 'PUT',
    query: { settings: 'true' },
    headers: {},
    body: { changes: { forged: true } },
  }, res);
  assert.equal(res.statusCode, 400);
});