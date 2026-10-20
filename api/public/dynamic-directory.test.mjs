import test from 'node:test';
import assert from 'node:assert/strict';

import { PUBLIC_DIRECTORY_SELECT, buildPublicDirectoryPayload, dynamicDirectoryHandler } from './dynamic-directory.js';
import { resolveBackFieldOrder, MEMBER_BACK_DEFAULT_ORDER } from '../_lib/directoryConfig.js';

test('public directory select fetches the back-order override columns', () => {
  assert.ok(PUBLIC_DIRECTORY_SELECT.includes('back_field_order'));
  assert.ok(PUBLIC_DIRECTORY_SELECT.includes('show_members_on_card_back'));
});

test('public payload excludes Data Studio fields even when saved in a public directory order', () => {
  const payload = buildPublicDirectoryPayload({
    id: 'dir-1', entity_type: 'organization',
    back_field_order: ['org_member_count', 'object-field:relationship:target:object:field', 'custom:f1'],
  });
  assert.deepEqual(payload.back_field_order, ['org_member_count', 'custom:f1']);
});

test('public payload exposes a saved back_field_order override', () => {
  const payload = buildPublicDirectoryPayload({
    id: 'd1', slug: 'devs', name: 'Devs', entity_type: 'member',
    back_field_order: ['show_awards', 'custom:f1', 'show_organization'],
    show_members_on_card_back: false,
  });
  assert.deepEqual(payload.back_field_order, ['show_awards', 'custom:f1', 'show_organization']);
  assert.equal(payload.show_members_on_card_back, false);

  // A public consumer resolving with this override gets the override-first order.
  const resolved = resolveBackFieldOrder({
    directoryOrder: payload.back_field_order,
    tenantOrder: ['show_organization', 'show_awards'],
    defaultOrder: MEMBER_BACK_DEFAULT_ORDER,
    customFields: [{ id: 'f1' }],
  });
  assert.deepEqual(resolved.slice(0, 3), ['show_awards', 'custom:f1', 'show_organization']);
});

test('public payload defaults: no override, members list shown', () => {
  const payload = buildPublicDirectoryPayload({ id: 'd2', slug: 'orgs', name: 'Orgs', entity_type: 'organization' });
  assert.equal(payload.back_field_order, null);
  assert.equal(payload.show_members_on_card_back, true);
  assert.equal(buildPublicDirectoryPayload(null), null);
});

// Explicit schema contract: unlike permissive row mocks, reject unknown
// organization columns even when no rows would match the query.
function organizationDatabase({ onRead } = {}) {
  const columns = new Set('id tenant_id name logo_url description city country website_url phone'.split(' '));
  const directory = {
    id: 'dir-1', tenant_id: 'tenant-1', slug: 'partners', name: 'Partners',
    entity_type: 'organization', is_active: true, allowed_role_ids: [],
    filter_field_id: 'eligible', filter_value: 'yes',
  };
  const seed = {
    dynamic_directory: [directory, { ...directory, id: 'other-dir', tenant_id: 'tenant-2' }],
    organization: [
      ...['Alpha', 'Beta', 'Gamma', 'Excluded'].map((name, index) => ({
        id: `org-${index}`, tenant_id: 'tenant-1', name, city: 'London', country: 'UK',
        logo_url: 'https://example.test/logo.png', description: 'Private description',
        website_url: 'https://example.test', phone: 'private phone',
      })),
      { id: 'foreign', tenant_id: 'tenant-2', name: 'Foreign', city: 'London' },
    ],
    preference_field: [{ id: 'eligible', tenant_id: 'tenant-1', entity_scope: 'organization', is_active: true, field_type: 'dropdown' }],
    organization_preference_value: ['org-0', 'org-1', 'org-2', 'foreign'].map((id, index) => ({
      id: `pv-${index}`, organization_id: id, field_id: 'eligible', value: 'yes',
    })),
    system_settings: [],
  };
  const calls = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.predicates = [];
      this.orders = [];
      this.start = 0;
      this.end = Infinity;
    }
    select(selection) {
      this.selection = selection;
      if (this.table === 'organization') {
        const invalid = selection.split(',').map(x => x.trim()).find(x => !columns.has(x));
        if (invalid) this.error = { code: '42703', message: `column organization.${invalid} does not exist` };
      }
      return this;
    }
    eq(key, value) { this.predicates.push(row => row[key] === value); return this; }
    in(key, values) { this.predicates.push(row => values.includes(row[key])); return this; }
    like(key, pattern) { this.predicates.push(row => String(row[key]).startsWith(pattern.replace(/%$/, ''))); return this; }
    or(expression) {
      this.predicates.push(row => expression.split(',').some(clause => {
        const [key, operator, pattern] = clause.split('.');
        assert.equal(operator, 'ilike');
        return String(row[key] || '').toLowerCase().includes(pattern.replaceAll('%', '').toLowerCase());
      }));
      return this;
    }
    order(key, options = {}) { this.orders.push([key, options.ascending !== false]); return this; }
    range(start, end) { this.start = start; this.end = end; return this; }
    limit(limit) { this.end = limit - 1; return this; }
    then(resolve, reject) {
      calls.push(this);
      onRead?.(this, seed);
      if (this.error) return Promise.resolve({ data: null, error: this.error }).then(resolve, reject);
      let rows = seed[this.table].filter(row => this.predicates.every(predicate => predicate(row)));
      for (const [key, ascending] of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
      }
      const count = rows.length;
      rows = rows.slice(this.start, this.end + 1).map(row => this.selection === '*'
        ? { ...row }
        : Object.fromEntries(this.selection.split(',').map(key => key.trim()).map(key => [key, row[key]])));
      return Promise.resolve({ data: rows, error: null, count }).then(resolve, reject);
    }
  }
  return { from: table => new Query(table), calls };
}

async function organizationRequest(query = {}, options = {}) {
  const db = organizationDatabase(options);
  const res = {
    statusCode: 200, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(key, value) { this.headers[key] = value; },
    json(payload) { this.payload = payload; return this; },
  };
  await dynamicDirectoryHandler({ method: 'GET', query: { slug: 'partners', ...query } }, res, {
    supabase: db,
    resolveTenant: async () => ({ id: 'tenant-1' }),
    getTenantContext: async () => ({ tenantId: 'tenant-1', isAuthenticated: false }),
  });
  return { res, db };
}

test('schema fixture rejects organization.slug but permits the directory slug', async () => {
  const db = organizationDatabase();
  assert.equal((await db.from('organization').select('id, slug')).error.code, '42703');
  assert.equal((await db.from('dynamic_directory').select('slug')).data[0].slug, 'partners');
});

test('guest organization list uses supported columns, eligible tenant IDs and publication-safe records', async () => {
  const { res, db } = await organizationRequest();
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 3);
  assert.deepEqual(res.payload.records.map(row => row.id), ['org-0', 'org-1', 'org-2']);
  assert.deepEqual(res.payload.records[0], {
    id: 'org-0', name: 'Alpha', subtitle: 'London, UK',
    logo_url: 'https://example.test/logo.png', image_url: 'https://example.test/logo.png', slug: null,
  });
  assert.equal(res.payload.config.directory.slug, 'partners');
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.ok(db.calls.some(q => q.table === 'organization' && q.selection.includes('name')));
});

test('organization list preserves search, descending sort, exact count and pagination', async () => {
  const { res } = await organizationRequest({ search: 'london', sort: 'name-desc', page: '2', limit: '1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 3);
  assert.equal(res.payload.page, 2);
  assert.equal(res.payload.pageSize, 1);
  assert.deepEqual(res.payload.records.map(row => row.id), ['org-1']);
  const searched = await organizationRequest({ search: 'Gamma' });
  assert.equal(searched.res.payload.total, 1);
  assert.equal(searched.res.payload.records[0].id, 'org-2');
  const missing = await organizationRequest({ slug: 'missing-directory' });
  assert.equal(missing.res.statusCode, 404);
});

test('organization list still rejects publication and inclusion changes during loading', async () => {
  for (const change of [
    seed => { seed.dynamic_directory[0].allowed_role_ids = ['private-role']; },
    seed => { seed.organization_preference_value = []; },
  ]) {
    const { res } = await organizationRequest({}, { onRead(query, seed) {
      if (query.table === 'organization' && query.selection.includes('name')) change(seed);
    } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.records, undefined);
  }
});
