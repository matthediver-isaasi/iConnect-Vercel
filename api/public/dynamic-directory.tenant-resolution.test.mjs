import test from 'node:test';
import assert from 'node:assert/strict';

const TENANT_ID = 'tenant-from-param';
const TENANT_SLUG = 'shared-host-tenant';
const DIRECTORY_SLUG = 'directory-with-different-slug';

// Import after installing a transport-only Supabase mock.  This leaves
// resolveTenantFromRequest un-injected: its real tenant lookup runs against
// the mocked database transport below.
process.env.SUPABASE_URL = 'https://tenant-resolution-db.test';
process.env.SUPABASE_SERVICE_KEY = 'tenant-resolution-test-key';

const tenantTransportCalls = [];
globalThis.fetch = async (requestUrl) => {
  const url = new URL(String(requestUrl));
  tenantTransportCalls.push(url.toString());
  if (!url.pathname.endsWith('/rest/v1/tenant')) {
    return new Response(JSON.stringify({}), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const slug = url.searchParams.get('slug')?.replace(/^eq\./, '');
  const tenant = slug === TENANT_SLUG ? {
    id: TENANT_ID,
    slug: TENANT_SLUG,
    status: 'active',
    name: 'Shared Host Tenant',
  } : null;
  return new Response(JSON.stringify(tenant), {
    status: tenant ? 200 : 406,
    headers: { 'content-type': 'application/json' },
  });
};

const { dynamicDirectoryHandler } = await import('./dynamic-directory.js?tenant-resolution-regression');

function database(seed, calls) {
  class Query {
    constructor(table) {
      this.table = table;
      this.predicates = [];
      this.sorts = [];
      this.start = 0;
      this.end = Number.POSITIVE_INFINITY;
      this.max = Number.POSITIVE_INFINITY;
    }

    select(selection) {
      this.selection = selection;
      return this;
    }

    eq(column, value) {
      this.predicates.push((row) => row[column] === value);
      return this;
    }

    in(column, values) {
      this.predicates.push((row) => values.includes(row[column]));
      return this;
    }

    order(column, options = {}) {
      this.sorts.push({ column, ascending: options.ascending !== false });
      return this;
    }

    range(start, end) {
      this.start = start;
      this.end = end;
      return this;
    }

    limit(max) {
      this.max = max;
      return this;
    }

    then(resolve, reject) {
      calls.push({ table: this.table, predicates: this.predicates.length });
      let rows = structuredClone(seed[this.table] || [])
        .filter((row) => this.predicates.every((predicate) => predicate(row)));
      for (const { column, ascending } of [...this.sorts].reverse()) {
        rows.sort((left, right) => {
          const a = String(left[column] ?? '');
          const b = String(right[column] ?? '');
          return (a < b ? -1 : a > b ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      rows = rows.slice(this.start, Math.min(this.end + 1, this.start + this.max));
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    }
  }

  return { from: (table) => new Query(table) };
}

function response() {
  return {
    statusCode: 200,
    payload: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function request(query) {
  return {
    method: 'GET',
    query,
    headers: { host: 'localhost' },
  };
}

function authenticatedContext() {
  return {
    tenantId: TENANT_ID,
    tenantUserId: 'tenant-user-1',
    isAuthenticated: true,
    roleId: null,
    organizationId: null,
    memberId: null,
    memberExcludedFeatures: [],
  };
}

function carouselDirectory() {
  return {
    id: 'directory-1',
    tenant_id: TENANT_ID,
    slug: DIRECTORY_SLUG,
    entity_type: 'organization',
    filter_field_id: null,
    filter_value: null,
    is_active: true,
    allowed_role_ids: [],
  };
}

test('shared localhost request resolves tenant param independently of directory slug', async () => {
  tenantTransportCalls.length = 0;
  const databaseCalls = [];
  const res = response();
  await dynamicDirectoryHandler(
    request({
      mode: 'carousel',
      tenant: TENANT_SLUG,
      slug: DIRECTORY_SLUG,
      limit: '1',
    }),
    res,
    {
      supabase: database({
        dynamic_directory: [carouselDirectory()],
        organization: [
          { id: 'correct-org', tenant_id: TENANT_ID, name: 'Correct Tenant Org', logo_url: null },
          { id: 'wrong-org', tenant_id: 'other-tenant', name: 'Wrong Tenant Org', logo_url: null },
        ],
      }, databaseCalls),
      // This is only the authenticated context used by the carousel access
      // check; tenant resolution itself remains the real implementation.
      getTenantContext: async () => authenticatedContext(),
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 1);
  assert.deepEqual(res.payload.records.map((record) => record.id), ['correct-org']);
  assert.ok(tenantTransportCalls.some((url) => url.includes('slug=eq.shared-host-tenant')));
  assert.ok(databaseCalls.some(({ table }) => table === 'dynamic_directory'));
  assert.ok(databaseCalls.some(({ table }) => table === 'organization'));
});

test('shared localhost request without tenant is denied instead of using directory slug', async () => {
  tenantTransportCalls.length = 0;
  const databaseCalls = [];
  const res = response();
  await dynamicDirectoryHandler(
    request({ mode: 'carousel', slug: DIRECTORY_SLUG }),
    res,
    {
      supabase: database({
        dynamic_directory: [carouselDirectory()],
        organization: [{ id: 'correct-org', tenant_id: TENANT_ID, name: 'Correct Tenant Org' }],
      }, databaseCalls),
      getTenantContext: async () => authenticatedContext(),
    },
  );

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Invalid tenant context' });
  assert.equal(tenantTransportCalls.length, 0);
  assert.equal(databaseCalls.length, 0);
});