import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './event-invoice-address.js';
const context = { isAuthenticated: true, tenantId: 'tenant', memberId: 'member' };

async function request({ ctx = context, method = 'POST', body = { eventId: 'event', source: 'simple' }, headers = {}, existing = true, error = false } = {}) {
  const calls = [];
  const db = { from(table) {
    const filters = {};
    const q = { select() { return q; }, limit() { return q; }, eq(key, value) { filters[key] = value; return q; }, maybeSingle() { return q; },
      then(resolve, reject) {
        calls.push({ table, filters });
        const rows = { event: { id: 'event' }, member: { id: 'member', first_name: 'Buyer', email: 'buyer@example.test' },
          tenant_accounting_settings: { active_provider: 'xero' }, system_settings: { setting_value: 'true' },
          tenant_integrations: { is_enabled: true }, xero_token: [{ id: 'connection', tenant_id: 'company' }],
          bnms_dd_beta_invoice_link: [], bnms_dd_alpha_invoice_link: [],
          invoicing_address_private: { invoicing_address_line1: 'Private personal address' } };
        return Promise.resolve({ data: rows[table] }).then(resolve, reject);
      } };
    return q;
  } };
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await handler({ method, body, headers }, res, { db, getTenantContext: async () => ctx, lookup: async () => {
    if (error) throw new Error('Provider unavailable');
    return existing ? { ContactID: 'private-provider-id' } : null;
  } });
  return { res, calls };
}

test('discovery requires authenticated member and tenant match before private reads', async () => {
  for (const args of [{ ctx: null }, { ctx: { ...context, memberId: null } }, { headers: { 'x-tenant-id': 'foreign' } },
    { ctx: { ...context, tenantMismatch: true } }]) {
    const { res, calls } = await request(args);
    assert.ok([401, 403].includes(res.statusCode));
    assert.equal(calls.length, 0);
  }
});
test('existing customer discovery exposes no provider identity or private addresses', async () => {
  const { res, calls } = await request();
  assert.deepEqual(res.body, { applicable: true, required: false, personalAddress: null, organizationAddress: null, organizationLabel: null });
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(calls.some(c => c.table === 'invoicing_address_private'), false);
  assert.ok(calls.every(c => c.filters.tenant_id === 'tenant' || c.filters.app_tenant_id === 'tenant'));
});
test('absent customer discovery returns personal structured address only to its own member', async () => {
  const { res, calls } = await request({ existing: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.required, true);
  assert.equal(res.body.personalAddress.address.invoicing_address_line1, 'Private personal address');
  assert.equal(calls.find(c => c.table === 'invoicing_address_private').filters.owner_id, 'member');
});
test('bad source/method and provider failures are explicit, not absence success', async () => {
  assert.equal((await request({ method: 'GET' })).res.statusCode, 405);
  assert.equal((await request({ body: { eventId: 'event', source: 'membership' } })).res.statusCode, 400);
  assert.equal((await request({ error: true })).res.statusCode, 503);
});
