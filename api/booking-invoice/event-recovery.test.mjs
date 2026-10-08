import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function serve({ source = 'booking', provider = 'xero', legacy = false, authorized = true, admin = false, contextTenant = 'tenant' }) {
  let code = await readFile(new URL('./[bookingGroupRef].js', import.meta.url), 'utf8');
  code = code.replace(/^import .*;\r?$/gm, '').replace('export default async function handler', 'async function handler');
  const calls = [];
  const row = {
    member_id: authorized ? 'member' : 'other', organization_id: null,
    accounting_provider: legacy ? null : provider,
    accounting_invoice_id: legacy ? null : 'generic-id',
    xero_invoice_id: legacy ? 'legacy-id' : null,
    accounting_invoice_number: 'INV-1',
  };
  const db = { from(table) {
    const filters = {};
    const query = {
      select(value) { calls.push({ table, select: value, filters }); return query; },
      eq(key, value) { filters[key] = value; return query; },
      or() { return query; }, limit() { return query; },
      maybeSingle: async () => ({ data: table === source ? row : null, error: null }),
    };
    return query;
  } };
  const handler = new Function('supabase', 'getSessionMember', 'getAccountingProvider', 'getAccountingProviderByName', 'getTenantContext', 'hasAdminAccess', `${code}; return handler;`)(
    db,
    async () => ({ id: 'member', tenant_id: 'tenant' }),
    async () => { assert.fail('Must not use the tenant active provider for pinned or legacy linkage'); },
    name => ({ fetchInvoicePdf: async (id, tenant) => { calls.push({ provider: name, id, tenant }); return Buffer.from('%PDF fixture'); } }),
    async () => ({ isAuthenticated: true, tenantId: contextTenant }),
    async () => admin,
  );
  const res = {
    code: 200, headers: {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; },
    setHeader(key, value) { this.headers[key] = value; },
  };
  await handler({ method: 'GET', query: { bookingGroupRef: 'GROUP', inline: 'true' } }, res);
  return { ...res, calls };
}

test('PDF uses stored provider for both tables and Xero for legacy linkage despite provider switches', async () => {
  for (const source of ['booking', 'complex_event_booking']) {
    for (const legacy of [true, false]) {
      const result = await serve({ source, legacy, provider: 'quickbooks' });
      assert.equal(result.code, 200);
      assert.equal(result.headers['Content-Type'], 'application/pdf');
      assert.deepEqual(result.calls.at(-1), { provider: legacy ? 'xero' : 'quickbooks', id: legacy ? 'legacy-id' : 'generic-id', tenant: 'tenant' });
      for (const query of result.calls.filter(call => call.table)) {
        assert.equal(query.filters.tenant_id, 'tenant');
        assert.equal(query.filters.booking_group_reference, 'GROUP');
        assert.match(query.select, /accounting_provider/);
      }
    }
  }
});

test('PDF authorization is preserved before provider access', async () => {
  const result = await serve({ authorized: false });
  assert.equal(result.code, 403);
  assert.equal(result.calls.some(call => call.provider), false);
});

test('tenant administrators can view another member invoice but cannot cross tenant context', async () => {
  const allowed = await serve({ authorized: false, admin: true });
  assert.equal(allowed.code, 200);
  const denied = await serve({ authorized: false, admin: true, contextTenant: 'other' });
  assert.equal(denied.code, 403);
  assert.equal(denied.calls.length, 0);
});