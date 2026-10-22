import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './config.js';

const targetId = '11111111-1111-4111-8111-111111111111';
async function detailRequest({ missing = false, denied = false, organizationId = targetId } = {}) {
  const queries = [];
  const directory = { id: 'dir', tenant_id: 'tenant', slug: 'public', entity_type: 'organization', is_active: true, allowed_role_ids: denied ? ['private-role'] : [] };
  const tables = {
    dynamic_directory: [directory],
    organization: [
      { id: targetId, tenant_id: missing ? 'other-tenant' : 'tenant', name: 'Selected' },
      { id: 'other', tenant_id: 'tenant', name: 'Unrelated' },
    ],
    organization_preference_value: [
      { id: 'value-a', organization_id: targetId, field_id: 'hidden', value: 'Secret' },
      { id: 'value-b', organization_id: 'other', field_id: 'hidden', value: 'Unrelated secret' },
    ],
  };
  const db = { from(table) {
    const query = { table, filters: [] }; queries.push(query);
    let offset = 0;
    return {
      select() { return this; },
      eq(key, value) { query.filters.push([key, [value]]); return this; },
      in(key, values) { query.filters.push([key, values]); return this; },
      like() { return this; }, order() { return this; }, limit() { return this; },
      range(start) { offset = start; return this; },
      then(resolve) {
        const rows = (tables[table] || []).filter(row => query.filters.every(([key, values]) => values.includes(row[key])));
        return Promise.resolve({ data: offset ? [] : rows, error: null }).then(resolve);
      },
    };
  }};
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', query: { slug: 'public', organizationId } }, res, {
    supabase: db, getTenantContext: async () => ({ tenantId: 'tenant', isAuthenticated: false }),
  });
  return { res, queries };
}

test('single-organisation detail scopes inventory and values without loading roles', async () => {
  const { res, queries } = await detailRequest();
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.organizations.map(row => row.id), [targetId]);
  assert.deepEqual(res.body.allOrgPreferenceValues, []);
  assert.ok(queries.filter(q => q.table === 'organization').every(q =>
    q.filters.some(([key, values]) => key === 'id' && values[0] === targetId)
    && q.filters.some(([key, values]) => key === 'tenant_id' && values[0] === 'tenant')));
  assert.ok(queries.filter(q => q.table === 'organization_preference_value').every(q =>
    q.filters.some(([key, values]) => key === 'organization_id' && values.length === 1 && values[0] === targetId)));
  assert.equal(queries.some(q => q.table === 'role'), false);
  assert.equal(queries.filter(q => q.table === 'organization').length, 1, 'Exact ID read needs only one round trip');
  assert.ok(queries.filter(q => q.table === 'dynamic_directory').length >= 3, 'Final publication/inclusion checks retained');
});

test('detail cannot retrieve an organisation in another tenant', async () => {
  const { res } = await detailRequest({ missing: true });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.organizations, []);
  assert.deepEqual(res.body.allOrgPreferenceValues, []);
});

test('role-restricted detail denies guests before inventory reads', async () => {
  const { res, queries } = await detailRequest({ denied: true });
  assert.equal(res.code, 403);
  assert.equal(queries.some(q => q.table === 'organization'), false);
});

test('malformed organisation detail identifier is rejected', async () => {
  const { res, queries } = await detailRequest({ organizationId: ['bad'] });
  assert.equal(res.code, 400);
  assert.equal(queries.length, 0);
});

for (const enabled of [false, true]) {
  test(`guest config excludes billing addresses with core publication ${enabled}`, async () => {
    const selects = [];
    const directory = { id: 'dir', tenant_id: 'tenant', slug: 'public', entity_type: 'organization', is_active: true, allowed_role_ids: [] };
    const tables = {
      dynamic_directory: [directory],
      organization: [{ id: 'org', name: 'Public Organisation', invoicing_address: 'PRIVATE BILLING ADDRESS', website_url: 'https://example.test', phone: '123', description: 'Description' }],
      system_settings: [{ setting_key: 'org_directory_core_publication', setting_value: JSON.stringify({ org_website: enabled, org_phone: enabled, org_description: enabled }) }],
    };
    const db = { from(table) {
      let offset = 0;
      return {
        select(columns) { selects.push({ table, columns }); return this; },
        eq() { return this; }, in() { return this; }, like() { return this; },
        order() { return this; }, limit() { return this; },
        range(start) { offset = start; return this; },
        then(resolve) { return Promise.resolve({ data: offset ? [] : (tables[table] || []), error: null }).then(resolve); },
      };
    } };
    const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'GET', query: { slug: 'public' } }, res, {
      supabase: db, getTenantContext: async () => ({ tenantId: 'tenant', isAuthenticated: false }),
    });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.organizations.length, 1);
    assert.equal(Object.hasOwn(res.body.organizations[0], 'invoicing_address'), false);
    assert.equal(JSON.stringify(res.body).includes('PRIVATE BILLING ADDRESS'), false);
    assert.equal(Object.hasOwn(res.body.organizations[0], 'website_url'), enabled);
    assert.equal(selects.filter(s => s.table === 'organization').every(s => !s.columns.includes('invoicing_address')), true);
  });
}
