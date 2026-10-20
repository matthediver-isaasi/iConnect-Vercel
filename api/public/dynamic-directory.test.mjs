import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaCheckedDatabase } from './directory-schema-contract.mjs';

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
function organizationDatabase({ onRead, member = false } = {}) {
  const directory = {
    id: 'dir-1', tenant_id: 'tenant-1', slug: 'partners', name: 'Partners',
    entity_type: 'organization', is_active: true, allowed_role_ids: [],
    filter_field_id: 'eligible', filter_value: 'yes',
  };
  const seed = {
    dynamic_directory: [directory, { ...directory, id: 'other-dir', tenant_id: 'tenant-2' }],
    organization: [
      ...['Alpha', 'Beta', 'Gamma', 'Excluded'].map((name, index) => ({
        id: `org-${index}`, tenant_id: 'tenant-1', name,
        logo_url: 'https://example.test/logo.png', description: 'Private description',
        website_url: 'https://example.test', phone: 'private phone',
      })),
      { id: 'foreign', tenant_id: 'tenant-2', name: 'Foreign' },
    ],
    preference_field: [{ id: 'eligible', tenant_id: 'tenant-1', entity_scope: 'organization', is_active: true, field_type: 'dropdown' }],
    organization_preference_value: ['org-0', 'org-1', 'org-2', 'foreign'].map((id, index) => ({
      id: `pv-${index}`, organization_id: id, field_id: 'eligible', value: 'yes',
    })),
    system_settings: [],
  };
  const calls = [];
  if (member) {
    directory.entity_type = 'member';
    seed.preference_field[0].entity_scope = 'member';
    seed.preference_field[0].directory_visibility = ['dir-1'];
    seed.member = ['Ada', 'Bea', 'Cara'].map((first_name, i) => ({
      id: `member-${i}`, tenant_id: 'tenant-1', first_name, last_name: 'Example',
      job_title: 'Engineer', email: `member-${i}@example.invalid`,
      linkedin_url: 'https://linkedin.com/in/example', organization_id: 'org-0',
      show_in_directory: true, login_enabled: true,
    }));
    seed.member_preference_value = seed.member.map((m, i) => ({
      id: `mpv-${i}`, member_id: m.id, field_id: 'eligible', value: 'yes',
    }));
    seed.role = [];
  }
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
      return this;
    }
    eq(key, value) { this.predicates.push(row => row[key] === value); return this; }
    in(key, values) { this.predicates.push(row => values.includes(row[key])); return this; }
    like(key, pattern) { this.predicates.push(row => String(row[key]).startsWith(pattern.replace(/%$/, ''))); return this; }
    not(key, operator, pattern) {
      assert.equal(operator, 'ilike');
      this.predicates.push(row => !new RegExp(`^${pattern.replaceAll('%', '.*').replaceAll('_', '.')}$`, 'i').test(row[key] || ''));
      return this;
    }
    or(expression) {
      this.predicates.push(row => expression.split(',').some(clause => {
        const [key, operator, pattern] = clause.split('.');
        if (operator === 'is') return row[key] == null;
        if (operator === 'neq') return row[key] !== false;
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
  return schemaCheckedDatabase({ from: table => new Query(table), calls });
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
  assert.throws(() => db.from('organization').select('id, slug'), /does not exist/);
  assert.equal((await db.from('dynamic_directory').select('slug')).data[0].slug, 'partners');
});

test('guest organization list uses supported columns, eligible tenant IDs and publication-safe records', async () => {
  const { res, db } = await organizationRequest();
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 3);
  assert.deepEqual(res.payload.records.map(row => row.id), ['org-0', 'org-1', 'org-2']);
  assert.deepEqual(res.payload.records[0], {
    id: 'org-0', name: 'Alpha', subtitle: null,
    logo_url: 'https://example.test/logo.png', image_url: 'https://example.test/logo.png', slug: null,
  });
  assert.equal(res.payload.config.directory.slug, 'partners');
  assert.equal(res.headers['Cache-Control'], 'private, no-store, max-age=0');
  assert.ok(db.calls.some(q => q.table === 'organization' && q.selection.includes('name')));
});

test('organization list preserves search, descending sort, exact count and pagination', async () => {
  const { res } = await organizationRequest({ search: 'a', sort: 'name-desc', page: '2', limit: '1' });
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

test('invalid references fail before empty-row evaluation across every query clause', () => {
  const db = schemaCheckedDatabase({ from: () => ({ select() { return this; }, eq() { return this; },
    in() { return this; }, not() { return this; }, or() { return this; }, order() { return this; } }) });
  for (const table of ['organization', 'member', 'dynamic_directory', 'preference_field', 'role',
    'system_settings', 'member_preference_value', 'organization_preference_value']) {
    for (const clause of [
      q => q.select('invented'), q => q.eq('invented', 'x'), q => q.in('invented', []),
      q => q.not('invented', 'is', null), q => q.or('invented.ilike.%x%'), q => q.order('invented'),
    ]) assert.throws(() => clause(db.from(table)), /does not exist/);
  }
  for (const field of ['city', 'country', 'slug']) {
    assert.throws(() => db.from('organization').select(field), /does not exist/);
    assert.throws(() => db.from('organization').or(`name.ilike.%a%,${field}.ilike.%a%`), /does not exist/);
  }
  assert.doesNotThrow(() => db.from('member').select('linkedin_url'));
});

test('member list keeps verified LinkedIn, helpers, custom filters, counts and pagination', async () => {
  const { res } = await organizationRequest({
    search: 'Engineer', sort: 'name-desc', page: '2', limit: '1', filters: '{"eligible":"yes"}',
  }, { member: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 3);
  assert.equal(res.payload.records[0].id, 'member-1');
  assert.equal(res.payload.records[0].linkedin_url, 'https://linkedin.com/in/example');
  assert.equal(res.payload.records[0].organization_name, 'Alpha');
  assert.equal(res.payload.records[0].customValues.eligible, 'yes');
});

test('both entity lists return successful empty searches and custom-filter results', async () => {
  for (const member of [false, true]) {
    for (const query of [{ search: 'No match' }, { filters: '{"eligible":"no"}' }]) {
      const { res } = await organizationRequest(query, { member });
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.total, 0);
      assert.deepEqual(res.payload.records, []);
    }
  }
});
