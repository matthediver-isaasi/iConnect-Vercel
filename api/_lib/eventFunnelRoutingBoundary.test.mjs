import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunnelPublicHandler } from './eventFunnelPublic.js';
import { createFunnelGuestCapability } from './eventFunnelJourneyHandler.js';
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenant = uuid(1), event = uuid(2), old = uuid(3), next = uuid(4), version = uuid(5);
const purchaser = { first_name: 'Original', last_name: 'Purchaser', email: 'original@example.test', organization: '' };
const graph = { version: 1, tenantId: tenant, entryMode: 'ticket_single', entry: 'source',
  reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'source', type: 'source', selectionMode: 'single', event: { id: event, kind: 'simple', tenantId: tenant },
      ticketIds: ['A', 'B'], requires: [], accept: 'checkout' }, { id: 'checkout', type: 'checkout' },
  ] };
function fixture({ normal = false, replay = false, lookupError = false, eligibilityError = false } = {}) {
  const calls = [], oldCapability = createFunnelGuestCapability(old), nextCapability = createFunnelGuestCapability(next);
  const outcome = normal ? { active: false, outcome: 'normal', reason: 'no_match' }
    : { active: true, routing: 'ticket', outcome: 'funnel', versionId: version, sourceNodeId: 'source' };
  const snapshot = id => ({ graph, serverNow: new Date().toISOString(), drafts: {}, holds: [
    { node_id: 'source', event_kind: 'simple', event_id: event, ticket_id: id === old ? 'A' : 'B',
      quantity: 3, price_snapshot: { purchaser } },
  ], session: { id, tenant_id: tenant, member_id: null, source_ticket_id: id === old ? 'A' : 'B',
    revision: 7, state: 'held', expires_at: new Date(Date.now() + 300000).toISOString() } });
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'event_funnel_consume_limit') return { data: true };
      if (name === 'event_funnel_replay_source_switch') return { data: { found: replay, outcome } };
      if (name === 'event_funnel_read_session') return { data: snapshot(args.p_id) };
      if (name === 'event_funnel_resolve_entry') return lookupError ? { error: { code: 'PGRST202' } } : { data: outcome };
      if (name === 'event_funnel_switch_source') return { data: outcome };
      assert.fail(`Unexpected RPC ${name}`);
    },
    from(table) {
      assert.equal(table, 'event_funnel_version');
      return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { graph } }; } };
    },
  };
  const handler = createFunnelPublicHandler('start', {
    db, resolveTenant: async () => ({ id: tenant }),
    // A newly signed-in viewer must not take over an old guest journey.
    loadViewer: async () => ({ tenantId: tenant, memberId: uuid(99) }),
    resolveSelection: async input => {
      calls.push(['eligibility', input]);
      if (eligibilityError) throw new Error('Eligibility unavailable');
      return { lines: [{ ticketId: 'B', priceSnapshot: { purchaser } }], answers: input.answers };
    },
  });
  return { calls, async invoke() {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: 'POST', headers: { host: 'example.test', 'content-type': 'application/json',
      cookie: [oldCapability.cookie.split(';')[0], nextCapability.cookie.split(';')[0]].join('; ') },
    body: { eventId: event, eventKind: 'simple', requestId: next, previousSessionId: old, expectedRevision: 7,
      tickets: [{ id: 'B', quantity: 3 }], answers: { purchaser: { email: purchaser.email, organization: '',
        last_name: purchaser.last_name, first_name: purchaser.first_name } } } }, res);
    return res;
  } };
}
test('source switch revalidates eligibility, binds current routing, and retains the original guest identity', async () => {
  const f = fixture(), res = await f.invoke();
  assert.equal(res.code, 201);
  const args = f.calls.find(call => call[0] === 'event_funnel_switch_source')[1];
  assert.equal(args.p_member, null);
  assert.equal(args.p_version, version);
  assert.equal(args.p_revision, 7);
  assert.equal(args.p_lines[0].quantity, 3);
  assert.equal(args.p_ticket, 'B');
  assert.equal(args.p_old, old);
});
test('normal source switch is explicit, while lookup and eligibility failures never release old stock', async () => {
  const normal = fixture({ normal: true });
  assert.equal((await normal.invoke()).body.outcome, 'normal');
  assert.equal(normal.calls.find(call => call[0] === 'event_funnel_switch_source')[1].p_version, null);
  for (const options of [{ lookupError: true }, { eligibilityError: true }]) {
    const f = fixture(options);
    assert.equal((await f.invoke()).code, 503);
    assert.equal(f.calls.some(call => call[0] === 'event_funnel_switch_source'), false);
  }
});
test('a committed switch replays its owned receipt without resolving new mappings or prices', async () => {
  const f = fixture({ replay: true, lookupError: true, eligibilityError: true }), res = await f.invoke();
  assert.equal(res.code, 200);
  assert.equal(res.body.session.id, next);
  assert.equal(f.calls.some(call => ['eligibility', 'event_funnel_resolve_entry', 'event_funnel_switch_source'].includes(call[0])), false);
});
