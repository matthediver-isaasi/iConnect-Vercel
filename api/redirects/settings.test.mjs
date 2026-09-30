import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedirectSettingsHandler } from './settings.js';

function createResponse() {
  return {
    statusCode: 200,
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

function createDatabase({ conflictOnce = false, roleExclusions = [] } = {}) {
  const state = {
    tenant: {
      id: 'tenant-1',
      settings: { unrelated: 'preserved' },
      updated_at: '2025-01-01T00:00:00.000Z',
      slug: 'tenant-one',
      domain: 'tenant.example',
    },
    writes: [],
    conflictOnce,
  };

  const database = {
    state,
    from(table) {
      let operation = 'select';
      let payload;
      const filters = [];
      const query = {
        select() {
          return query;
        },
        update(value) {
          operation = 'update';
          payload = structuredClone(value);
          return query;
        },
        eq(field, value) {
          filters.push({ field, value, kind: 'eq' });
          return query;
        },
        is(field, value) {
          filters.push({ field, value, kind: 'is' });
          return query;
        },
        async single() {
          if (table !== 'tenant') return { data: null, error: null };
          return { data: structuredClone(state.tenant), error: null };
        },
        async maybeSingle() {
          if (table === 'role') {
            return { data: { excluded_features: roleExclusions }, error: null };
          }
          if (table !== 'tenant' || operation !== 'update') {
            return { data: structuredClone(state.tenant), error: null };
          }

          if (state.conflictOnce) {
            state.conflictOnce = false;
            state.tenant.settings.concurrent = 'kept';
            state.tenant.updated_at = '2025-01-02T00:00:00.000Z';
            return { data: null, error: null };
          }

          const matches = filters.every(({ field, value }) => state.tenant[field] === value);
          if (!matches) return { data: null, error: null };
          state.writes.push(structuredClone(payload));
          Object.assign(state.tenant, structuredClone(payload));
          return { data: structuredClone(state.tenant), error: null };
        },
      };
      return query;
    },
  };
  return database;
}

function dependencies(database, overrides = {}) {
  return {
    supabase: database,
    getSessionTenantUser: async () => ({
      tenant_id: 'tenant-1',
      role: 'admin',
    }),
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      roleId: null,
      memberExcludedFeatures: [],
    }),
    hasAdminAccess: async () => true,
    clearTenantCache: () => {},
    isResourceExcluded: () => false,
    ...overrides,
  };
}

async function invoke(handler, method, body) {
  const response = createResponse();
  await handler({ method, body, headers: {} }, response);
  return response;
}

test('GET defaults the unknown-page fallback to false', async () => {
  const database = createDatabase();
  const response = await invoke(
    createRedirectSettingsHandler(dependencies(database)),
    'GET',
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { redirect_unknown_pages_to_homepage: false });
});

test('PUT stores a strict boolean while preserving unrelated tenant settings', async () => {
  const database = createDatabase();
  const cleared = [];
  const response = await invoke(
    createRedirectSettingsHandler(dependencies(database, {
      clearTenantCache: (key) => cleared.push(key),
    })),
    'PUT',
    { redirect_unknown_pages_to_homepage: true },
  );
  assert.equal(response.statusCode, 200);
  assert.deepEqual(database.state.tenant.settings, {
    unrelated: 'preserved',
    redirect_unknown_pages_to_homepage: true,
  });
  assert.deepEqual(cleared, ['tenant-one', 'tenant.example']);
});

test('PUT retries a concurrent settings change and preserves the concurrent key', async () => {
  const database = createDatabase({ conflictOnce: true });
  const response = await invoke(
    createRedirectSettingsHandler(dependencies(database)),
    'PUT',
    { redirect_unknown_pages_to_homepage: true },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(database.state.writes.length, 1);
  assert.deepEqual(database.state.tenant.settings, {
    unrelated: 'preserved',
    concurrent: 'kept',
    redirect_unknown_pages_to_homepage: true,
  });
});

test('PUT rejects non-boolean values without writing', async () => {
  const database = createDatabase();
  const response = await invoke(
    createRedirectSettingsHandler(dependencies(database)),
    'PUT',
    { redirect_unknown_pages_to_homepage: 'true' },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(database.state.writes.length, 0);
});

test('endpoint rejects unauthenticated callers', async () => {
  const database = createDatabase();
  const response = await invoke(
    createRedirectSettingsHandler(dependencies(database, {
      getSessionTenantUser: async () => null,
      getTenantContext: async () => ({
        isAuthenticated: false,
        tenantId: null,
      }),
    })),
    'GET',
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
});

test('member admins can read and update the setting without a tenant-user session', async () => {
  const database = createDatabase();
  const handler = createRedirectSettingsHandler(dependencies(database, {
    getSessionTenantUser: async () => null,
    hasAdminAccess: async (context) => context.memberId === 'member-admin',
    getTenantContext: async () => ({
      isAuthenticated: true,
      tenantId: 'tenant-1',
      memberId: 'member-admin',
      roleId: null,
      memberExcludedFeatures: [],
    }),
  }));

  const getResponse = await invoke(handler, 'GET');
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.headers['Cache-Control'], 'private, no-store, max-age=0');

  const putResponse = await invoke(handler, 'PUT', {
    redirect_unknown_pages_to_homepage: true,
  });
  assert.equal(putResponse.statusCode, 200);
  assert.equal(database.state.tenant.settings.redirect_unknown_pages_to_homepage, true);
  assert.equal(putResponse.headers['Cache-Control'], 'private, no-store, max-age=0');
});

test('member callers are denied unless they have admin and feature authority', async (t) => {
  const database = createDatabase();
  const memberContext = {
    isAuthenticated: true,
    tenantId: 'tenant-1',
    memberId: 'member-ordinary',
    roleId: null,
    memberExcludedFeatures: [],
  };

  await t.test('non-admin member', async () => {
    const response = await invoke(
      createRedirectSettingsHandler(dependencies(database, {
        getSessionTenantUser: async () => null,
        getTenantContext: async () => memberContext,
        hasAdminAccess: async () => false,
      })),
      'GET',
    );
    assert.equal(response.statusCode, 403);
  });

  await t.test('admin member with redirect management excluded', async () => {
    const roleRestrictedDatabase = createDatabase({
      roleExclusions: ['admin.redirect-management'],
    });
    const response = await invoke(
      createRedirectSettingsHandler(dependencies(roleRestrictedDatabase, {
        getSessionTenantUser: async () => null,
        getTenantContext: async () => ({
          ...memberContext,
          roleId: 'member-admin-role',
        }),
        hasAdminAccess: async () => true,
        isResourceExcluded: (exclusions, key) => exclusions.includes(key),
      })),
      'GET',
    );
    assert.equal(response.statusCode, 403);
  });
});

test('endpoint rejects tenant mismatches and feature exclusions', async (t) => {
  const database = createDatabase();
  await t.test('tenant mismatch', async () => {
    const response = await invoke(
      createRedirectSettingsHandler(dependencies(database, {
        getTenantContext: async () => ({
          isAuthenticated: true,
          tenantId: 'tenant-2',
          memberExcludedFeatures: [],
        }),
      })),
      'GET',
    );
    assert.equal(response.statusCode, 403);
  });

  await t.test('feature exclusion', async () => {
    const response = await invoke(
      createRedirectSettingsHandler(dependencies(database, {
        getTenantContext: async () => ({
          isAuthenticated: true,
          tenantId: 'tenant-1',
          memberExcludedFeatures: ['admin.redirect-management'],
        }),
        isResourceExcluded: (exclusions, key) => exclusions.includes(key),
      })),
      'GET',
    );
    assert.equal(response.statusCode, 403);
  });
});