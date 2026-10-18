import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tenant = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const memberId = '44444444-4444-4444-8444-444444444444';
const source = readFileSync(new URL('./ticket-members.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export default async function handler', 'return async function handler');
const makeHandler = new Function('supabase', 'getTenantContext', 'hasAdminAccess', 'getCallerGroupEventsAccess', source);

async function request({ admin = false, authenticated = true, tenantMismatch = false, groups = [], parent = { id: eventId, member_group_id: groupId }, query = {}, method = 'GET' } = {}) {
  const calls = [];
  const supabase = { from(table) {
    const filters = [];
    const result = { data: table === 'member' ? [{ id: memberId, first_name: 'Fixture' }] : parent, error: null };
    const chain = { then(resolve) { return Promise.resolve(result).then(resolve); } };
    for (const name of ['select', 'eq', 'in', 'limit', 'order', 'or', 'maybeSingle']) {
      chain[name] = (...args) => { filters.push([name, ...args]); return chain; };
    }
    calls.push({ table, filters });
    return chain;
  } };
  const handler = makeHandler(supabase, async () => ({ tenantId: tenant, isAuthenticated: authenticated, tenantMismatch }), async () => admin, async () => ({ groups }));
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method, query }, res);
  return { ...res, calls };
}

test('requires authentication and event management, not member directory access', async () => {
  assert.equal((await request({ authenticated: false })).statusCode, 401);
  const mismatch = await request({ admin: true, tenantMismatch: true, query: { q: 'Fi' } });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(mismatch.calls.length, 0);
  const denied = await request({ query: { q: 'Fi' } });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.calls.some(call => call.table === 'member'), false);
  assert.equal((await request({ method: 'POST', admin: true })).statusCode, 405);
});

test('admin search and hydration are bounded and tenant-scoped', async () => {
  const result = await request({ admin: true, query: { q: 'Fi', ids: memberId } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.results.length, 1);
  assert.equal(result.body.selected.length, 1);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  for (const call of result.calls) assert.ok(call.filters.some(([name, key, value]) => name === 'eq' && key === 'tenant_id' && value === tenant));
  assert.ok(result.calls.some(call => call.filters.some(([name, value]) => name === 'limit' && value === 25)));
  assert.equal((await request({ admin: true, query: { ids: 'invalid' } })).statusCode, 400);
  assert.equal((await request({ admin: true, query: { q: 'x'.repeat(101) } })).statusCode, 400);
});

test('group admins may search for their existing parent or new administered group, not another group', async () => {
  const groups = [{ groupId, simpleEnabled: true, complexEnabled: false }];
  assert.equal((await request({ groups, query: { event_id: eventId, q: 'Fi' } })).statusCode, 200);
  assert.equal((await request({ groups, query: { group_id: groupId, q: 'Fi' } })).statusCode, 200);
  assert.equal((await request({ groups, query: { group_id: eventId, q: 'Fi' } })).statusCode, 403);
  assert.equal((await request({ groups, parent: { id: eventId, member_group_id: memberId }, query: { event_id: eventId, group_id: groupId, q: 'Fi' } })).statusCode, 403);
  assert.equal((await request({ groups, query: { group_id: groupId, event_type: 'complex', q: 'Fi' } })).statusCode, 403);
  assert.equal((await request({ admin: true, parent: null, query: { event_id: eventId } })).statusCode, 404);
});
