import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFunnelPublicHandler, loadFunnelOffer } from './eventFunnelPublic.js';
import { funnelSimpleTickets } from '../../shared/eventFunnelCatalog.mjs';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = uuid(1), eventId = uuid(2), version = uuid(3), memberId = uuid(4);
const graph = { version: 1, tenantId: tenant, entry: 'source', invoiceMode: 'per_event', reservationSeconds: 900, nodes: [
  { id: 'source', type: 'source', event: { id: eventId, kind: 'simple', tenantId: tenant }, ticketIds: ['A'], requires: [], accept: 'checkout' },
  { id: 'checkout', type: 'checkout' },
] };
function fixture({ guest = true, readiness = { data: { version: 1, purchasing: true } }, active = true, limit = true } = {}) {
  const calls = [];
  let created;
  const db = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'event_funnel_readiness') return readiness;
    if (name === 'event_funnel_find_entry') return { data: active ? { active, versionId: version, sourceNodeId: 'source' } : { active: false } };
    if (name === 'event_funnel_consume_limit') return { data: limit };
    if (name === 'event_funnel_create_session') { created = args; return { data: {} }; }
    if (name === 'event_funnel_read_session') {
      assert.equal(args.p_id, created.p_id);
      assert.equal(args.p_capability_hash, created.p_capability_hash);
      assert.equal(args.p_member, created.p_member);
      return { data: { graph, drafts: {}, holds: [], serverNow: new Date().toISOString(),
        session: { id: args.p_id, tenant_id: tenant, member_id: args.p_member, state: 'draft', revision: 1,
          first_reserved_at: null, expires_at: null, journey: { version: 1, decisions: {}, checkoutNow: false } } } };
    }
    assert.fail(`Unexpected RPC ${name}`);
  } };
  const invoke = async (action, input = { eventId, eventKind: 'simple' }, headers = {}, method = action === 'entry' ? 'GET' : 'POST') => {
    const handler = createFunnelPublicHandler(action, { db, resolveTenant: async () => ({ id: tenant }),
      loadViewer: async () => guest ? null : { memberId, tenantId: tenant } });
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, query: input, body: input,
      headers: { host: 'example.test', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, response);
    return response;
  };
  return { calls, invoke, created: () => created };
}
test('legacy environments and inactive entries keep standalone registration', async () => {
  for (const options of [{ readiness: { error: { code: 'PGRST202' } } },
    { readiness: { data: { version: 1, purchasing: false } } }, { active: false }]) {
    const f = fixture(options), response = await f.invoke('entry');
    assert.equal(response.code, 200);
    assert.deepEqual(response.body, { active: false });
    assert.equal(f.calls.some(call => call.name === 'event_funnel_create_session'), false);
  }
  const f = fixture({ readiness: { error: { code: 'XX000' } } });
  assert.equal((await f.invoke('entry')).code, 503);
});
test('guest start creates an empty owned draft and issues only a secure HttpOnly capability', async () => {
  const f = fixture(), response = await f.invoke('start');
  assert.equal(response.code, 201);
  assert.equal(response.body.session.state, 'draft');
  assert.equal(response.body.session.first_reserved_at, null);
  assert.deepEqual(response.body.holds, []);
  const cookie = response.headers['Set-Cookie'];
  assert.match(cookie, /; Path=\/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$/);
  const token = cookie.split(';')[0].split('=')[1];
  assert.equal(f.created().p_capability_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal(f.created().p_member, null);
  assert.ok(!JSON.stringify(response.body).includes(token));
  assert.match(response.headers['Cache-Control'], /no-store/);
});
test('signed-in start binds the verified member, not submitted purchaser authority', async () => {
  const f = fixture({ guest: false }), response = await f.invoke('start');
  assert.equal(response.code, 201);
  assert.equal(response.body.session.member_id, memberId);
  assert.equal(f.created().p_capability_hash, null);
  assert.equal(response.headers['Set-Cookie'], undefined);
  assert.equal((await f.invoke('start', { eventId, eventKind: 'simple', memberId: uuid(9) })).code, 400);
});
test('forged requests, cross-site submission, disabled checkout and throttling cannot create sessions', async () => {
  const f = fixture();
  assert.equal((await f.invoke('start', { eventId, eventKind: 'simple' }, { origin: 'https://evil.test' })).code, 403);
  assert.equal((await f.invoke('start', { eventId, eventKind: 'simple' }, { 'content-type': 'text/plain' })).code, 403);
  assert.equal((await f.invoke('start', { eventId, eventKind: 'simple', nextNodeId: 'checkout' })).code, 400);
  assert.equal((await f.invoke('start', { eventId, eventKind: 'simple' }, {}, 'GET')).code, 405);
  assert.equal(f.calls.length, 0);
  assert.equal((await fixture({ active: false }).invoke('start')).code, 409);
  const throttled = fixture({ limit: false });
  assert.equal((await throttled.invoke('start')).code, 429);
  assert.equal(throttled.calls.some(call => call.name === 'event_funnel_create_session'), false);
});
test('offer reader rejects forged destinations and unmet prerequisites before any event read', async () => {
  const snapshot = { graph, route: { route: ['source'], retainedNodeIds: [] } };
  await assert.rejects(loadFunnelOffer(null, {}, snapshot, 'checkout'), { code: 'OFFER_UNAVAILABLE' });
  await assert.rejects(loadFunnelOffer(null, {}, snapshot, 'missing'), { code: 'OFFER_UNAVAILABLE' });
  const blocked = structuredClone(snapshot);
  blocked.graph.nodes[0].requires = ['missing'];
  await assert.rejects(loadFunnelOffer(null, {}, blocked, 'source'), { code: 'OFFER_UNAVAILABLE' });
});
test('legacy synthetic admission is never substituted for an empty or malformed configured ticket list', () => {
  assert.equal(funnelSimpleTickets({ pricing_config: null, ticket_price: 7 })[0].price, 7);
  assert.equal(funnelSimpleTickets({ pricing_config: '' })[0].id, 'default');
  assert.deepEqual(funnelSimpleTickets({ pricing_config: { ticket_classes: [] } }), []);
  assert.deepEqual(funnelSimpleTickets({ pricing_config: '{"ticket_classes":[]}' }), []);
  assert.throws(() => funnelSimpleTickets({ pricing_config: 'broken' }));
  assert.throws(() => funnelSimpleTickets({ pricing_config: { ticket_classes: 'broken' } }));
});
