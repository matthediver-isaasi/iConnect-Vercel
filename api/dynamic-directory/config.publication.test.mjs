import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './config.js';

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
