import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './invoicing-address.js';
import { INVOICING_ADDRESS_KEYS } from '../shared/invoicingAddress.js';
const tenant = '10000000-0000-0000-0000-000000000001';
const own = '20000000-0000-0000-0000-000000000001';
const other = '20000000-0000-0000-0000-000000000002';
const context = { isAuthenticated: true, tenantId: tenant, memberId: own };
const empty = () => Object.fromEntries(INVOICING_ADDRESS_KEYS.map(key => [key, null]));

function fixture({ ctx = context, admin = false, owner = true, missing = false, failSave = false } = {}) {
  const state = new Map();
  const calls = [];
  const db = {
    from(table) {
      const filters = {};
      return {
        select() { return this; },
        eq(key, value) { filters[key] = value; return this; },
        async maybeSingle() {
          calls.push({ table, filters });
          if (table === 'invoicing_address_private') {
            if (missing) return { error: { code: 'PGRST205' } };
            return { data: state.get(`${filters.owner_type}:${filters.owner_id}`) || null };
          }
          return { data: owner ? { id: filters.id, tenant_id: tenant } : null };
        },
      };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (missing || failSave) return { error: { code: missing ? 'PGRST202' : 'OTHER' } };
      const key = `${args.p_owner_type}:${args.p_owner_id}`;
      const row = { ...empty(), ...state.get(key), ...args.p_address };
      state.set(key, row);
      return { data: [{ ...row, owner_id: args.p_owner_id, tenant_id: tenant }] };
    },
  };
  async function request(method, ownerType = 'member', ownerId = own, address, extras = {}) {
    const req = { method, headers: {}, query: { ownerType, ownerId }, ...extras };
    if (method === 'PATCH') req.body = { ownerType, ownerId, address, ...extras.body };
    const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler(req, res, { db, getTenantContext: async () => ctx, hasAdminAccess: async () => admin });
    return res;
  }
  return { request, calls, state };
}

test('own member create/read/partial edit/clear uses private endpoint and never owner columns', async () => {
  const f = fixture();
  assert.deepEqual((await f.request('GET')).body, { address: empty() });
  const created = await f.request('PATCH', 'member', own, { invoicing_address_line1: '  Own street ', invoicing_country: 'United Kingdom' });
  assert.equal(created.statusCode, 200);
  assert.equal(created.body.address.invoicing_address_line1, 'Own street');
  assert.deepEqual(Object.keys(created.body), ['address']);
  assert.deepEqual(Object.keys(created.body.address), INVOICING_ADDRESS_KEYS);
  await f.request('PATCH', 'member', own, { invoicing_city: 'London' });
  assert.equal((await f.request('GET')).body.address.invoicing_address_line1, 'Own street');
  await f.request('PATCH', 'member', own, { invoicing_city: ' ' });
  assert.equal((await f.request('GET')).body.address.invoicing_city, null);
  await f.request('PATCH', 'member', own, empty());
  assert.deepEqual((await f.request('GET')).body.address, empty());
  assert.ok(f.calls.filter(call => call.table === 'member').every(call => call.filters.tenant_id === tenant));
  assert.ok(f.calls.filter(call => call.name).every(call => call.name === 'patch_private_invoicing_address'));
});

test('organization and group addresses are admin-only, independent and tenant-scoped', async () => {
  const f = fixture({ admin: true });
  for (const ownerType of ['member', 'organization', 'organization_group']) {
    const result = await f.request('PATCH', ownerType, own, { invoicing_address_line1: `${ownerType} street` });
    assert.equal(result.statusCode, 200);
  }
  for (const ownerType of ['member', 'organization', 'organization_group']) {
    assert.equal((await f.request('GET', ownerType)).body.address.invoicing_address_line1, `${ownerType} street`);
  }
  for (const ownerType of ['organization', 'organization_group']) {
    const denied = fixture();
    assert.equal((await denied.request('GET', ownerType)).statusCode, 403);
    assert.equal((await denied.request('PATCH', ownerType, own, { invoicing_city: 'X' })).statusCode, 403);
    assert.equal(denied.calls.length, 0);
  }
  assert.equal((await fixture().request('GET', 'member', other)).statusCode, 403);
  assert.equal((await fixture({ admin: true, owner: false }).request('GET', 'organization')).statusCode, 404);
  assert.equal((await fixture({ ctx: { ...context, tenantId: other }, admin: true }).request('GET')).statusCode, 404);
});

test('missing migration and failed writes surface errors rather than empty-address success', async () => {
  for (const method of ['GET', 'PATCH']) {
    const res = await fixture({ missing: true }).request(method, 'member', own, { invoicing_city: 'X' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'INVOICING_ADDRESS_STORAGE_UNAVAILABLE');
    assert.equal(res.body.address, undefined);
  }
  assert.equal((await fixture({ failSave: true }).request('PATCH', 'member', own, { invoicing_city: 'X' })).statusCode, 500);
});

test('authorization and validation reject forged tenant context and invalid payloads', async () => {
  assert.equal((await fixture({ ctx: {} }).request('GET')).statusCode, 401);
  assert.equal((await fixture({ ctx: { ...context, tenantMismatch: true } }).request('GET')).statusCode, 403);
  assert.equal((await fixture().request('GET', 'member', own, undefined, { headers: { 'x-tenant-id': other } })).statusCode, 403);
  assert.equal((await fixture().request('GET', 'member', own, undefined, { headers: { 'x-tenant-id': tenant } })).statusCode, 200);
  for (const address of [{}, [], { other: 'value' }, { invoicing_city: {} }, { invoicing_country: 'x'.repeat(51) }, { invoicing_address_line1: 'a\nb' }]) {
    const f = fixture();
    assert.equal((await f.request('PATCH', 'member', own, address)).statusCode, 400);
    assert.equal(f.calls.length, 0);
  }
  assert.equal((await fixture().request('PATCH', 'member', own, { invoicing_city: 'x' }, { body: { tenant_id: other } })).statusCode, 400);
  assert.equal((await fixture().request('GET', 'tenant')).statusCode, 400);
  assert.equal((await fixture().request('GET', 'member', 'invalid')).statusCode, 400);
  assert.equal((await fixture().request('POST')).statusCode, 405);
});
