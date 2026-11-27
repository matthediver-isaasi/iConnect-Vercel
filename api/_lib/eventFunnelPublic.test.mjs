import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFunnelPublicHandler, listRoutedTickets, loadFunnelOffer } from './eventFunnelPublic.js';
import { funnelSimpleTickets } from '../../shared/eventFunnelCatalog.mjs';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = uuid(1), eventId = uuid(2), version = uuid(3), memberId = uuid(4);
const graph = { version: 1, tenantId: tenant, entry: 'source', invoiceMode: 'per_event', reservationSeconds: 900, nodes: [
  { id: 'source', type: 'source', event: { id: eventId, kind: 'simple', tenantId: tenant }, ticketIds: ['A'], requires: [], accept: 'checkout' },
  { id: 'checkout', type: 'checkout' },
] };
function fixture({ guest = true, readiness = { data: { version: 1, purchasing: true } }, active = true, limit = true } = {}) {
  const calls = [];
  let created, holds = [];
  const entry = active ? { active, routing: 'ticket', outcome: 'funnel', versionId: version, sourceNodeId: 'source' }
    : { active: false, outcome: 'normal', reason: 'no_match' };
  const db = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'event_funnel_resolve_entry') return readiness.error ? readiness
      : readiness.data.purchasing === false ? { error: { code: 'PT409' } } : { data: entry };
    if (name === 'event_funnel_consume_limit') return { data: limit };
    if (name === 'event_funnel_start_routed') { created = args; return { data: entry }; }
    if (name === 'event_funnel_apply_journey') {
      holds = args.p_lines.map(line => ({ node_id: line.nodeId, ticket_id: line.ticketId,
        quantity: line.quantity, event_kind: 'simple', event_id: eventId, price_snapshot: line.priceSnapshot }));
      return db.rpc('event_funnel_read_session', args);
    }
    if (name === 'event_funnel_read_session') {
      assert.equal(args.p_id, created.p_id);
      assert.equal(args.p_capability_hash, created.p_capability_hash);
      assert.equal(args.p_member, created.p_member);
      return { data: { graph, drafts: {}, holds, serverNow: new Date().toISOString(),
        session: { id: args.p_id, tenant_id: tenant, member_id: args.p_member, state: holds.length ? 'held' : 'draft', revision: 1,
          first_reserved_at: null, expires_at: null, journey: { version: 1, decisions: {}, checkoutNow: false } } } };
    }
    assert.fail(`Unexpected RPC ${name}`);
  } };
  const invoke = async (action, input = action === 'entry' ? { eventId, eventKind: 'simple' }
    : { eventId, eventKind: 'simple', requestId: uuid(50), tickets: [{ id: 'A', quantity: 2 }], answers: {} },
    headers = {}, method = action === 'entry' ? 'GET' : 'POST') => {
    const handler = createFunnelPublicHandler(action, { db, resolveTenant: async () => ({ id: tenant }),
      loadViewer: async () => guest ? null : { memberId, tenantId: tenant },
      resolveSelection: async ({ tickets }) => ({ lines: tickets.map(ticket => ({ ticketId: ticket.id, priceSnapshot: { version: 1, unitMinor: 0 } })), answers: {} }) });
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, query: input, body: input,
      headers: { host: 'example.test', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, response);
    return response;
  };
  return { calls, invoke, created: () => created };
}
test('only authoritative no-match uses normal checkout; missing schema and inactive purchasing are errors', async () => {
  const normal = await fixture({ active: false }).invoke('entry');
  assert.equal(normal.code, 200);
  assert.equal(normal.body.outcome, 'normal');
  assert.equal((await fixture({ readiness: { error: { code: 'PGRST202' } } }).invoke('entry')).code, 503);
  assert.equal((await fixture({ readiness: { data: { purchasing: false } } }).invoke('entry')).code, 409);
  const f = fixture({ readiness: { error: { code: 'XX000' } } });
  assert.equal((await f.invoke('entry')).code, 503);
});
test('guest start selects source with a secure HttpOnly capability and no client version authority', async () => {
  const f = fixture(), response = await f.invoke('start');
  assert.equal(response.code, 201);
  assert.equal(response.body.session.state, 'held');
  assert.equal(response.body.session.first_reserved_at, null);
  assert.equal(response.body.holds[0].quantity, 2);
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
  assert.equal((await fixture({ active: false }).invoke('start')).body.outcome, 'normal');
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
test('normal outcomes never create or reserve a journey and source routing uses server-owned class lookup', async () => {
  const f = fixture({ active: false });
  const res = await f.invoke('start');
  assert.equal(res.body.outcome, 'normal');
  assert.equal(f.calls.some(call => call.name === 'event_funnel_apply_journey'), false);
  const routed = f.calls.find(call => call.name === 'event_funnel_start_routed');
  assert.equal(routed.args.p_ticket, 'A');
  assert.equal(routed.args.p_version, undefined);
  assert.equal(routed.args.p_tenant, tenant);
});

function catalogueFixture({ kind = 'simple', pricing = { ticket_classes: [{ id: 'A' }, { id: 'B' }, { id: 'A' }] },
  complexIds = ['A', 'B'], catalogueError = false, resolverError = false } = {}) {
  const resolved = [], reads = [];
  const db = {
    from(table) {
      assert.equal(table, kind === 'simple' ? 'event' : 'complex_event_ticket_class',
        'routing tables deny direct reads to service_role');
      const filters = {};
      reads.push({ table, filters });
      return {
        select() { return this; },
        eq(key, value) { filters[key] = value; return this; },
        order(key) { assert.equal(key, 'id'); return this; },
        async maybeSingle() {
          return catalogueError ? { error: { code: 'XX000' } }
            : { data: { id: eventId, tenant_id: tenant, pricing_config: pricing } };
        },
        async range(start, end) {
          return catalogueError ? { error: { code: 'XX000' } }
            : { data: complexIds.slice(start, end + 1).map(id => ({ id })) };
        },
      };
    },
    async rpc(name, args) {
      assert.equal(name, 'event_funnel_resolve_entry');
      assert.equal(args.p_tenant, tenant);
      assert.equal(args.p_event_id, eventId);
      assert.equal(args.p_event_kind, kind);
      if (args.p_ticket === null) return { data: { active: true, routing: 'ticket', selectionMode: 'single' } };
      resolved.push(args.p_ticket);
      if (resolverError) return { error: { code: 'XX000' } };
      return { data: args.p_ticket === 'A'
        ? { active: true, routing: 'ticket', outcome: 'funnel', versionId: version, sourceNodeId: 'source' }
        : { active: false, outcome: 'normal', reason: 'no_match' } };
    },
  };
  return { db, resolved, reads };
}

test('ticket-routed entry works with direct routing-table reads denied', async () => {
  for (const kind of ['simple', 'complex']) {
    const f = catalogueFixture({ kind });
    const handler = createFunnelPublicHandler('entry', { db: f.db, resolveTenant: async () => ({ id: tenant }),
      loadViewer: async () => null });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'GET', query: { eventKind: kind, eventId } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.routedTicketIds, ['A']);
    assert.equal(res.body.selectionMode, 'single');
    assert.match(res.headers['Cache-Control'], /no-store/);
    assert.deepEqual(f.resolved, ['A', 'B']);
    assert.deepEqual(f.reads[0].filters, { tenant_id: tenant, [kind === 'simple' ? 'id' : 'complex_event_id']: eventId });
  }
});

test('catalogue discovery preserves legacy, empty and JSON pricing semantics', async () => {
  for (const [pricing, expected] of [[null, ['default']], ['', ['default']],
    [{ ticket_classes: [] }, []], ['{"ticket_classes":[{"id":"A"}]}', ['A']]]) {
    const f = catalogueFixture({ pricing });
    await listRoutedTickets(f.db, tenant, 'simple', eventId);
    assert.deepEqual(f.resolved, expected);
  }
});

test('complex discovery checks all pages rather than silently truncating mapped tickets', async () => {
  const f = catalogueFixture({ kind: 'complex', complexIds: [...Array.from({ length: 500 }, (_, i) => `T${i}`), 'A'] });
  assert.deepEqual(await listRoutedTickets(f.db, tenant, 'complex', eventId), ['A']);
  assert.equal(f.resolved.length, 501);
  assert.equal(f.reads.length, 2);
});

test('catalogue and resolver failures never become a verified unmapped result', async () => {
  for (const kind of ['simple', 'complex']) {
    for (const failure of [{ catalogueError: true }, { resolverError: true }]) {
      const f = catalogueFixture({ kind, ...failure });
      await assert.rejects(listRoutedTickets(f.db, tenant, kind, eventId), { code: 'JOURNEY_UNAVAILABLE' });
    }
  }
  const f = catalogueFixture({ pricing: 'invalid JSON' });
  await assert.rejects(listRoutedTickets(f.db, tenant, 'simple', eventId));
  assert.deepEqual(f.resolved, []);
});
