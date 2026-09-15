import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeCarouselDirectory,
  buildCarouselResponse,
  dynamicDirectoryHandler,
  parseCarouselAllowedRoleIds,
  seededOrganizationOrder,
} from './dynamic-directory.js';
import { createOrganisationDirectoryFilters } from '../_lib/organisationDirectoryFilters.js';

const TENANT_ID = 'tenant-carousel';

function organizations(count, tenantId = TENANT_ID) {
  return Array.from({ length: count }, (_, index) => ({
    id: `org-${String(index).padStart(4, '0')}`,
    tenant_id: tenantId,
    name: `Organisation ${index}`,
    logo_url: index % 2 ? `https://cdn.example.test/${index}.png` : null,
    description: index % 3 ? `Description ${index}` : null,
    website_url: index % 4 ? `https://org-${index}.example.test` : null,
    internal_notes: `must never leave the API ${index}`,
    account_balance: index * 100,
  }));
}

function database(seed, failures = {}, hooks = {}) {
  class Query {
    constructor(table) {
      this.table = table;
      this.failure = failures[table] || null;
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

    is(column, value) {
      this.predicates.push((row) => value === null ? row[column] == null : row[column] === value);
      return this;
    }

    not(column, operator, value) {
      if (operator === 'ilike') {
        const pattern = String(value).replaceAll('%', '').toLowerCase();
        this.predicates.push((row) => !String(row[column] || '').toLowerCase().includes(pattern));
      }
      return this;
    }

    or(expression) {
      const clauses = String(expression).split(',');
      this.predicates.push((row) => clauses.some((clause) => {
        const [column, operator, expected] = clause.split('.');
        if (operator === 'is' && expected === 'null') return row[column] == null;
        if (operator === 'neq' && expected === 'false') return row[column] !== false;
        return true;
      }));
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

    rows() {
      let rows = structuredClone(seed[this.table] || [])
        .filter((row) => this.predicates.every((predicate) => predicate(row)));
      for (const { column, ascending } of [...this.sorts].reverse()) {
        rows.sort((left, right) => {
          const a = String(left[column] ?? '');
          const b = String(right[column] ?? '');
          return (a < b ? -1 : a > b ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      return rows.slice(this.start, Math.min(this.end + 1, this.start + this.max));
    }

    then(resolve, reject) {
      hooks[this.table]?.(seed);
      if (this.failure) {
        return Promise.resolve({ data: null, error: this.failure }).then(resolve, reject);
      }
      return Promise.resolve({ data: this.rows(), error: null }).then(resolve, reject);
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

function publicContext() {
  return { tenantId: TENANT_ID, isAuthenticated: true, roleId: 'role-directory' };
}

function directory(overrides = {}) {
  return {
    id: 'directory-orgs',
    tenant_id: TENANT_ID,
    slug: 'organisations',
    entity_type: 'organization',
    filter_field_id: null,
    filter_value: null,
    is_active: true,
    allowed_role_ids: [],
    ...overrides,
  };
}

test('carousel ordering is deterministic for a 1,200-organisation inventory', () => {
  const rows = organizations(1200);
  const first = seededOrganizationOrder(rows, 'alpha').map((row) => row.id);
  const second = seededOrganizationOrder(rows, 'alpha').map((row) => row.id);

  assert.equal(first.length, 1200);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 1200);
});

test('different seeds produce different global orders for large inventories', () => {
  const rows = organizations(1200);
  const alpha = seededOrganizationOrder(rows, 'alpha').map((row) => row.id);
  const beta = seededOrganizationOrder(rows, 'beta').map((row) => row.id);

  assert.notDeepEqual(alpha, beta);
});

test('carousel pagination slices after global ordering and has no duplicate page IDs', () => {
  const rows = organizations(120);
  const all = seededOrganizationOrder(rows, 'alpha').map((row) => row.id);
  const pageOne = buildCarouselResponse(rows, { page: 1, pageSize: 50, seed: 'alpha' });
  const pageTwo = buildCarouselResponse(rows, { page: 2, pageSize: 50, seed: 'alpha' });
  const pageThree = buildCarouselResponse(rows, { page: 3, pageSize: 50, seed: 'alpha' });

  assert.deepEqual(pageOne.records.map((row) => row.id), all.slice(0, 50));
  assert.deepEqual(pageTwo.records.map((row) => row.id), all.slice(50, 100));
  assert.deepEqual(pageThree.records.map((row) => row.id), all.slice(100, 120));
  assert.equal(new Set([...pageOne.records, ...pageTwo.records].map((row) => row.id)).size, 100);
  assert.equal(pageOne.total, 120);
});

test('default seed is alpha and empty seeds do not change ordering', () => {
  const rows = organizations(60);
  assert.deepEqual(
    buildCarouselResponse(rows, { pageSize: 4 }).records,
    buildCarouselResponse(rows, { pageSize: 4, seed: 'alpha' }).records,
  );
  assert.equal(buildCarouselResponse(rows, { pageSize: 4 }).seed, 'alpha');
});

test('carousel projection is an exact allow-list and strips internal organisation fields', () => {
  const responseData = buildCarouselResponse(organizations(1), { pageSize: 1 });
  const record = responseData.records[0];

  assert.deepEqual(Object.keys(record).sort(), [
    'description',
    'id',
    'logo_url',
    'name',
    'website_url',
  ]);
  assert.equal('internal_notes' in record, false);
  assert.equal('account_balance' in record, false);
});

test('missing optional organisation values are represented as null, never by private fields', () => {
  const [record] = buildCarouselResponse([{
    id: 'org-1',
    name: 'One',
    internal_notes: 'private',
  }], { pageSize: 1 }).records;

  assert.deepEqual(record, {
    id: 'org-1',
    name: 'One',
    logo_url: null,
    description: null,
    website_url: null,
  });
});

test('allowed-role policy accepts public, JSON, and de-duplicates role IDs', () => {
  assert.deepEqual(parseCarouselAllowedRoleIds(null), { valid: true, ids: [] });
  assert.deepEqual(parseCarouselAllowedRoleIds('[]'), { valid: true, ids: [] });
  assert.deepEqual(parseCarouselAllowedRoleIds(['role-a', 'role-a', ' role-b ']), {
    valid: true,
    ids: ['role-a', 'role-b'],
  });
  assert.deepEqual(parseCarouselAllowedRoleIds('["role-a"]'), {
    valid: true,
    ids: ['role-a'],
  });
});

test('malformed role policy fails closed instead of becoming public', () => {
  for (const value of ['not-json', '{}', [null], ['']]) {
    assert.equal(parseCarouselAllowedRoleIds(value).valid, false);
  }
});

test('carousel authorization requires the resolved tenant', () => {
  assert.equal(authorizeCarouselDirectory({
    context: { tenantId: 'other-tenant', isAuthenticated: false },
    tenantId: TENANT_ID,
    allowedRoleIds: [],
  }).allowed, false);
  assert.equal(authorizeCarouselDirectory({
    context: { tenantId: TENANT_ID, tenantMismatch: true },
    tenantId: TENANT_ID,
    allowedRoleIds: [],
  }).allowed, false);
});

test('empty role policy allows all authenticated member roles, never anonymous access', () => {
  assert.equal(authorizeCarouselDirectory({
    context: { tenantId: TENANT_ID, isAuthenticated: false },
    tenantId: TENANT_ID,
    allowedRoleIds: [],
    featureAllowed: true,
  }).allowed, false);
  assert.equal(authorizeCarouselDirectory({
    context: publicContext(),
    tenantId: TENANT_ID,
    allowedRoleIds: [],
    featureAllowed: true,
  }).allowed, true);
});

test('private carousel requires authentication and an allowed member role', () => {
  const policy = { tenantId: TENANT_ID, allowedRoleIds: ['role-allowed'], featureAllowed: true };
  assert.equal(authorizeCarouselDirectory({
    context: publicContext(),
    ...policy,
  }).allowed, false);
  assert.equal(authorizeCarouselDirectory({
    context: { tenantId: TENANT_ID, isAuthenticated: true, roleId: 'role-denied' },
    ...policy,
  }).allowed, false);
  assert.equal(authorizeCarouselDirectory({
    context: { tenantId: TENANT_ID, isAuthenticated: true, roleId: 'role-allowed' },
    ...policy,
  }).allowed, true);
});

test('tenant users bypass directory role restrictions, matching authenticated directory policy', () => {
  assert.equal(authorizeCarouselDirectory({
    context: { tenantId: TENANT_ID, isAuthenticated: true, tenantUserId: 'admin-1' },
    tenantId: TENANT_ID,
    allowedRoleIds: ['role-not-admin'],
  }).allowed, true);
});

test('carousel denies anonymous requests without a publication grant', async () => {
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory()],
        organization: organizations(10),
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => ({ tenantId: TENANT_ID, isAuthenticated: false }),
    },
  );

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { error: 'Authentication required' });
});

test('carousel enforces feature access and hierarchical member exclusions', async () => {
  const makeRequest = async ({ featureAllowed, exclusions }) => {
    const result = response();
    await dynamicDirectoryHandler(
      { method: 'GET', query: { mode: 'carousel', slug: 'organisations' } },
      result,
      {
        supabase: database({ dynamic_directory: [directory()], organization: organizations(2) }),
        resolveTenant: async () => ({ id: TENANT_ID }),
        getTenantContext: async () => publicContext(),
        hasFeatureAccess: async () => featureAllowed,
        resolveMemberExclusions: async () => exclusions,
      },
    );
    return result;
  };

  assert.equal((await makeRequest({ featureAllowed: false, exclusions: [] })).statusCode, 403);
  assert.equal((await makeRequest({ featureAllowed: true, exclusions: ['membership'] })).statusCode, 403);
});

test('carousel rejects embed callers and marks responses private no-store', async () => {
  const res = response();
  await dynamicDirectoryHandler(
    {
      method: 'GET',
      query: { mode: 'carousel', slug: 'organisations', embed: 'true' },
      headers: {},
    },
    res,
    {
      supabase: database({ dynamic_directory: [directory()], organization: organizations(2) }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, { error: 'Embed access denied' });
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
});

test('handler returns only the requested bounded carousel page for 1,200 organisations', async () => {
  const db = database({
    dynamic_directory: [directory()],
    organization: organizations(1200),
  });
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', page: '4', limit: '4', seed: 'alpha' } },
    res,
    {
      supabase: db,
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.records.length, 4);
  assert.equal(res.payload.total, 1200);
  assert.equal(res.payload.page, 4);
  assert.equal(res.payload.pageSize, 4);
  assert.equal(res.payload.seed, 'alpha');
  assert.equal(JSON.stringify(res.payload).length < 5000, true);
});

test('handler clamps an oversized limit to the carousel maximum', async () => {
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '100000', seed: 'alpha' } },
    res,
    {
      supabase: database({ dynamic_directory: [directory()], organization: organizations(100) }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.records.length, 50);
});

test('handler applies the saved organisation filter before global seeded ordering', async () => {
  const rows = organizations(80);
  const filtered = rows.filter((_, index) => index % 2 === 0);
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '4', seed: 'alpha' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory({ filter_field_id: 'sector', filter_value: 'listed' })],
        organization: rows,
        preference_field: [{
          id: 'sector',
          tenant_id: TENANT_ID,
          entity_scope: 'organization',
          is_active: true,
        }],
        organization_preference_value: filtered.map((row) => ({
          organization_id: row.id,
          field_id: 'sector',
          value: 'listed',
        })),
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, filtered.length);
  assert.equal(res.payload.records.every((row) => filtered.some((candidate) => candidate.id === row.id)), true);
});

test('handler applies organisation-directory display and exclusion settings', async () => {
  const rows = organizations(3);
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '10', seed: 'alpha' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory()],
        organization: rows,
        system_settings: [
          { tenant_id: TENANT_ID, setting_key: 'org_directory_show_logo', setting_value: 'false' },
          { tenant_id: TENANT_ID, setting_key: 'org_directory_show_title', setting_value: 'false' },
          { tenant_id: TENANT_ID, setting_key: 'org_directory_show_domains', setting_value: 'false' },
          {
            tenant_id: TENANT_ID,
            setting_key: 'org_directory_excluded_orgs',
            setting_value: JSON.stringify([rows[1].id]),
          },
        ],
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 2);
  assert.equal(res.payload.records.some((row) => row.id === rows[1].id), false);
  assert.equal(res.payload.records.every((row) =>
    row.name === null && row.logo_url === null && row.website_url === null), true);
});

test('carousel enforces global status/type eligibility after the saved filter, with own-org bypass', async () => {
  const rows = [
    { ...organizations(1)[0], id: 'own' },
    { ...organizations(1)[0], id: 'eligible' },
    { ...organizations(1)[0], id: 'wrong-status' },
    { ...organizations(1)[0], id: 'wrong-type' },
  ];
  const res = response();
  const preferenceValues = rows.flatMap((row, index) => [
    { organization_id: row.id, field_id: 'sector', value: 'listed' },
    {
      organization_id: row.id,
      field_id: 'application-status',
      value: index === 1 || index === 3 ? 'approved' : 'pending',
    },
    {
      organization_id: row.id,
      field_id: 'org-type',
      value: index === 1 || index === 2 ? 'member' : 'prospect',
    },
  ]);
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '10', seed: 'alpha' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory({ filter_field_id: 'sector', filter_value: 'listed' })],
        organization: rows,
        preference_field: [
          {
            id: 'sector', tenant_id: TENANT_ID, entity_scope: 'organization', is_active: true,
          },
          {
            id: 'application-status', tenant_id: TENANT_ID, entity_scope: 'organization',
            // Legacy eligibility definitions remain authoritative even when
            // inactive; this mirrors the canonical authenticated listing.
            name: 'application_status', is_active: false,
          },
          {
            id: 'org-type', tenant_id: TENANT_ID, entity_scope: 'organization',
            name: 'org_type', is_active: true,
          },
        ],
        organization_preference_value: preferenceValues,
        system_settings: [
          {
            tenant_id: TENANT_ID,
            setting_key: 'org_directory_allowed_application_statuses',
            setting_value: '["approved"]',
          },
          {
            tenant_id: TENANT_ID,
            setting_key: 'org_directory_visible_org_types',
            setting_value: '["member"]',
          },
          {
            tenant_id: TENANT_ID,
            setting_key: 'org_directory_excluded_orgs',
            setting_value: '["own"]',
          },
        ],
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => ({ ...publicContext(), organizationId: 'own' }),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(new Set(res.payload.records.map((row) => row.id)), new Set(['own', 'eligible']));
  assert.equal(res.payload.records.some((row) => row.id === 'wrong-status'), false);
  assert.equal(res.payload.records.some((row) => row.id === 'wrong-type'), false);
});

test('carousel eligibility stays in parity with canonical directory population for inactive legacy fields', async () => {
  const seed = {
    dynamic_directory: [directory()],
    organization: [
      { id: 'own', tenant_id: TENANT_ID, name: 'Own' },
      { id: 'eligible', tenant_id: TENANT_ID, name: 'Eligible' },
      { id: 'wrong-status', tenant_id: TENANT_ID, name: 'Wrong status' },
      { id: 'wrong-type', tenant_id: TENANT_ID, name: 'Wrong type' },
    ],
    preference_field: [
      {
        id: 'legacy-status', tenant_id: TENANT_ID, entity_scope: 'organization',
        name: 'application_status', is_active: false,
      },
      {
        id: 'active-type', tenant_id: TENANT_ID, entity_scope: 'organization',
        name: 'organisation_type', is_active: true,
      },
    ],
    organization_preference_value: [
      { organization_id: 'own', field_id: 'legacy-status', value: 'pending' },
      { organization_id: 'own', field_id: 'active-type', value: 'prospect' },
      { organization_id: 'eligible', field_id: 'legacy-status', value: 'approved' },
      { organization_id: 'eligible', field_id: 'active-type', value: 'member' },
      { organization_id: 'wrong-status', field_id: 'legacy-status', value: 'pending' },
      { organization_id: 'wrong-status', field_id: 'active-type', value: 'member' },
      { organization_id: 'wrong-type', field_id: 'legacy-status', value: 'approved' },
      { organization_id: 'wrong-type', field_id: 'active-type', value: 'prospect' },
    ],
    system_settings: [
      {
        tenant_id: TENANT_ID,
        setting_key: 'org_directory_allowed_application_statuses',
        setting_value: '["approved"]',
      },
      {
        tenant_id: TENANT_ID,
        setting_key: 'org_directory_visible_org_types',
        setting_value: '["member"]',
      },
      {
        tenant_id: TENANT_ID,
        setting_key: 'org_directory_excluded_orgs',
        setting_value: '["own"]',
      },
    ],
  };
  const canonical = createOrganisationDirectoryFilters({
    db: database(seed),
    context: { tenantId: TENANT_ID, roleId: 'role-directory', organizationId: 'own' },
  });
  const canonicalResult = await canonical.search({
    filters: {},
    search: '',
    sort: 'asc',
    page: 1,
    pageSize: 20,
  });

  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '20', seed: 'alpha' } },
    res,
    {
      supabase: database(seed),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => ({ ...publicContext(), organizationId: 'own' }),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.deepEqual(res.payload.records.map((row) => row.id), canonicalResult.organizations.map((row) => row.id));
});

test('carousel returns 409 when status policy mutates during the organization scan', async () => {
  const state = {
    dynamic_directory: [directory()],
    organization: organizations(1200),
    system_settings: [{
      tenant_id: TENANT_ID,
      setting_key: 'org_directory_allowed_application_statuses',
      setting_value: '["approved"]',
    }],
  };
  let mutated = false;
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', seed: 'alpha' } },
    res,
    {
      supabase: database(state, {}, {
        organization: (db) => {
          if (!mutated) {
            mutated = true;
            db.system_settings[0].setting_value = '["pending"]';
          }
        },
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { error: 'Directory authority changed; retry' });
});

test('carousel returns 409 when type policy mutates during the organization scan', async () => {
  const state = {
    dynamic_directory: [directory()],
    organization: organizations(1200),
    system_settings: [{
      tenant_id: TENANT_ID,
      setting_key: 'org_directory_visible_org_types',
      setting_value: '["member"]',
    }],
  };
  let mutated = false;
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', seed: 'alpha' } },
    res,
    {
      supabase: database(state, {}, {
        organization: (db) => {
          if (!mutated) {
            mutated = true;
            db.system_settings[0].setting_value = '["partner"]';
          }
        },
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { error: 'Directory authority changed; retry' });
});

test('carousel returns 409 when an eligibility field is deactivated during the scan', async () => {
  const state = {
    dynamic_directory: [directory()],
    organization: organizations(1200),
    preference_field: [{
      id: 'application-status',
      tenant_id: TENANT_ID,
      entity_scope: 'organization',
      name: 'application_status',
      is_active: true,
    }],
    system_settings: [{
      tenant_id: TENANT_ID,
      setting_key: 'org_directory_allowed_application_statuses',
      setting_value: '["approved"]',
    }],
  };
  let mutated = false;
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', seed: 'alpha' } },
    res,
    {
      supabase: database(state, {}, {
        organization: (db) => {
          if (!mutated) {
            mutated = true;
            db.preference_field[0].is_active = false;
          }
        },
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { error: 'Directory authority changed; retry' });
});

test('carousel projects only canonical verified domains as safe HTTPS URLs', async () => {
  const rows = organizations(2);
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '10', seed: 'alpha' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory()],
        organization: rows,
        preference_field: [{
          id: 'verified-domains',
          tenant_id: TENANT_ID,
          entity_scope: 'organization',
          name: 'verified_domains',
          is_active: true,
        }],
        organization_preference_value: [
          {
            organization_id: rows[0].id,
            field_id: 'verified-domains',
            value: JSON.stringify(['example.test', 'https://ignored.example.test']),
          },
          {
            organization_id: rows[1].id,
            field_id: 'verified-domains',
            value: 'http://insecure.example.test',
          },
        ],
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  const byId = new Map(res.payload.records.map((row) => [row.id, row]));
  assert.equal(res.statusCode, 200);
  assert.equal(byId.get(rows[0].id).description, null);
  assert.equal(byId.get(rows[0].id).website_url, 'https://example.test');
  assert.equal(byId.get(rows[1].id).description, null);
  assert.equal(byId.get(rows[1].id).website_url, null);
});

test('carousel returns 409 when display authority mutates during the organization scan', async () => {
  const state = {
    dynamic_directory: [directory()],
    organization: organizations(1200),
  };
  let mutated = false;
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', seed: 'alpha' } },
    res,
    {
      supabase: database(state, {}, {
        organization: (db) => {
          if (!mutated) {
            mutated = true;
            db.system_settings = [{
              tenant_id: TENANT_ID,
              setting_key: 'org_directory_show_title',
              setting_value: 'false',
            }];
          }
        },
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { error: 'Directory authority changed; retry' });
});

test('carousel returns 409 when the saved filter authority mutates during the scan', async () => {
  const state = {
    dynamic_directory: [directory({ filter_field_id: 'sector', filter_value: 'listed' })],
    organization: organizations(1200),
    preference_field: [{
      id: 'sector',
      tenant_id: TENANT_ID,
      entity_scope: 'organization',
      is_active: true,
    }],
    organization_preference_value: [],
  };
  let mutated = false;
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', seed: 'alpha' } },
    res,
    {
      supabase: database(state, {}, {
        organization: (db) => {
          if (!mutated) {
            mutated = true;
            db.preference_field[0].is_active = false;
          }
        },
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { error: 'Directory authority changed; retry' });
});

test('carousel returns 409 when requester organisation changes during the scan', async () => {
  const rows = organizations(1200);
  let contextCalls = 0;
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', seed: 'alpha' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory()],
        organization: rows,
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => ({
        ...publicContext(),
        organizationId: rows[contextCalls++ === 0 ? 0 : 1].id,
      }),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { error: 'Directory authority changed; retry' });
});

test('carousel returns 409 when the verified-domain source mutates during the scan', async () => {
  const state = {
    dynamic_directory: [directory()],
    organization: organizations(1200),
    preference_field: [{
      id: 'verified-domains',
      tenant_id: TENANT_ID,
      entity_scope: 'organization',
      name: 'verified_domains',
      is_active: true,
    }],
    organization_preference_value: [],
  };
  let mutated = false;
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', seed: 'alpha' } },
    res,
    {
      supabase: database(state, {}, {
        organization: (db) => {
          if (!mutated) {
            mutated = true;
            db.preference_field[0].is_active = false;
          }
        },
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, { error: 'Directory authority changed; retry' });
});

test('requester organisation remains visible despite global exclusions', async () => {
  const rows = organizations(3);
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '10', seed: 'alpha' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory()],
        organization: rows,
        system_settings: [
          {
            tenant_id: TENANT_ID,
            setting_key: 'org_directory_excluded_orgs',
            setting_value: JSON.stringify(rows.map((row) => row.id)),
          },
        ],
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => ({
        ...publicContext(),
        isAuthenticated: true,
        organizationId: rows[0].id,
      }),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.records.map((row) => row.id), [rows[0].id]);
});

test('carousel saved filters fail closed for fields owned by another tenant', async () => {
  const rows = organizations(2);
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations', limit: '10', seed: 'alpha' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory({ filter_field_id: 'foreign-field', filter_value: 'listed' })],
        organization: rows,
        preference_field: [{
          id: 'foreign-field',
          tenant_id: 'another-tenant',
          entity_scope: 'organization',
          is_active: true,
        }],
        organization_preference_value: rows.map((row) => ({
          organization_id: row.id,
          field_id: 'foreign-field',
          value: 'listed',
        })),
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 0);
  assert.equal(res.payload.records.length, 0);
});

test('carousel saved-filter query failures return an error instead of broadening results', async () => {
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory({ filter_field_id: 'sector', filter_value: 'listed' })],
        organization: organizations(2),
        preference_field: [{
          id: 'sector',
          tenant_id: TENANT_ID,
          entity_scope: 'organization',
          is_active: true,
        }],
      }, {
        organization_preference_value: { message: 'preference query failed', code: 'XX000' },
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, { error: 'Failed to fetch directory records' });
});

test('malformed organisation-directory settings fail closed', async () => {
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory()],
        organization: organizations(2),
        system_settings: [{
          tenant_id: TENANT_ID,
          setting_key: 'org_directory_excluded_orgs',
          setting_value: '{bad-json',
        }],
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, { error: 'Failed to fetch directory records' });
});

test('handler denies a private directory before reading organisations', async () => {
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory({ allowed_role_ids: ['role-member'] })],
        organization: organizations(100),
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, { error: 'Directory access denied' });
});

test('handler denies malformed private policy and inactive directories', async () => {
  const malformed = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations' } },
    malformed,
    {
      supabase: database({
        dynamic_directory: [directory({ allowed_role_ids: '{bad' })],
        organization: organizations(10),
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );
  assert.equal(malformed.statusCode, 403);

  const inactive = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'organisations' } },
    inactive,
    {
      supabase: database({
        dynamic_directory: [directory({ is_active: false })],
        organization: organizations(10),
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );
  assert.equal(inactive.statusCode, 404);
});

test('handler rejects a member directory in carousel mode', async () => {
  const res = response();
  await dynamicDirectoryHandler(
    { method: 'GET', query: { mode: 'carousel', slug: 'members' } },
    res,
    {
      supabase: database({
        dynamic_directory: [directory({ entity_type: 'member', slug: 'members' })],
      }),
      resolveTenant: async () => ({ id: TENANT_ID }),
      getTenantContext: async () => publicContext(),
      hasFeatureAccess: async () => true,
      resolveMemberExclusions: async () => [],
    },
  );
  assert.equal(res.statusCode, 400);
});
