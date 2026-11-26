import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventFunnelAdminHandler, validateFunnelLayout, validateFunnelReferences } from './eventFunnelAdmin.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
const eventId = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000003';
const graph = () => ({
  version: 1, tenantId, reservationSeconds: 900, invoiceMode: 'per_event', entry: 'source',
  nodes: [
    { id: 'source', type: 'source', event: { id: eventId, kind: 'simple', tenantId }, ticketIds: ['standard'], requires: [], accept: 'checkout' },
    { id: 'checkout', type: 'checkout' },
  ],
});
function harness(overrides = {}, eventRow = { id: eventId, start_date: '2099-01-01T12:00:00Z', pricing_config: { ticket_classes: [{ id: 'standard' }] } }) {
  const calls = [];
  const context = { isAuthenticated: true, tenantId, tenantUserId: id };
  const db = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'event_funnel_consume_limit') return { data: true };
      if (name === 'event_funnel_save_definition') return { data: { id, revision: 1 } };
      return { data: { authoring: true, purchasing: false } };
    },
    from: table => {
      calls.push(['from', table]);
      const chain = {};
      for (const method of ['select', 'eq', 'order', 'limit']) chain[method] = (...args) => {
        calls.push([method, ...args]); return chain;
      };
      chain.maybeSingle = async () => ({ data: eventRow });
      chain.then = resolve => resolve({ data: [] });
      return chain;
    },
  };
  const handler = createEventFunnelAdminHandler({
    db, getContext: async () => context, hasAdminAccess: async () => true,
    hasFeatureAccess: async () => true, ...overrides,
  });
  const invoke = async (body, headers = {}, method = 'POST') => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method, headers: { host: 'example.test', 'content-type': 'application/json', ...headers }, body }, res);
    return res;
  };
  return { invoke, calls, db };
}
const save = () => ({ action: 'save', id, name: 'Admissions', expectedRevision: 0, graph: graph(), layout: { positions: {} } });
test('past, undated and completed future events fail before saving', async () => {
  for (const event of [{start_date:'2000-01-01'}, {}, {start_date:'2099-01-01',status:'completed'}]) {
    const query = {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{id:eventId,...event}};}};
    await assert.rejects(validateFunnelReferences({from:()=>query},tenantId,graph()),
      /Choose a future event/);
  }
});
test('saves tenant-scoped graphs with compare-and-swap revision and separate layout', async () => {
  const h = harness(), res = await h.invoke(save());
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { id, revision: 1 });
  const call = h.calls.find(([name]) => name === 'event_funnel_save_definition')[1];
  assert.equal(call.p_tenant, tenantId);
  assert.equal(call.p_expected_revision, 0);
  assert.deepEqual(call.p_layout, { positions: {} });
  assert.ok(h.calls.some(call => call[0] === 'eq' && call[1] === 'tenant_id' && call[2] === tenantId));
});
test('preview is side-effect free apart from rate limiting', async () => {
  const h = harness();
  const res = await h.invoke({ action: 'preview', graph: graph(), selections: [{ nodeId: 'source', tickets: [{ id: 'standard', quantity: 1 }] }] });
  assert.equal(res.code, 200);
  assert.equal(res.body.atCheckout, true);
  assert.deepEqual(h.calls.filter(([name]) => name.startsWith('event_funnel_')).map(([name]) => name), ['event_funnel_consume_limit']);
});
for (const [name, context, expected] of [
  ['unauthenticated', null, 401],
  ['tenant mismatch', { isAuthenticated: true, tenantId, tenantMismatch: true }, 409],
  ['missing identity', { isAuthenticated: true, tenantId }, 403],
]) test(`denies ${name} before storage operations`, async () => {
  const h = harness({ getContext: async () => context });
  assert.equal((await h.invoke(save())).code, expected);
  assert.deepEqual(h.calls, []);
});
test('requires administrator and event-management authority', async () => {
  const deniedAdmin = harness({ hasAdminAccess: async () => false });
  assert.equal((await deniedAdmin.invoke(save())).code, 403);
  const deniedFeature = harness({ getContext: async () => ({ isAuthenticated: true, tenantId, memberId: id, roleId: id }), hasFeatureAccess: async () => false });
  assert.equal((await deniedFeature.invoke(save())).code, 403);
});
test('rejects cross-origin and form posts before storage operations', async () => {
  for (const headers of [{ origin: 'https://attacker.test' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    const h = harness();
    assert.equal((await h.invoke(save(), headers)).code, 403);
    assert.deepEqual(h.calls, []);
  }
});
test('rejects forged tenant and ticket references', async () => {
  const h = harness(), body = save();
  body.graph.tenantId = id;
  assert.equal((await h.invoke(body)).code, 400);
  const wrongTicket = save(); wrongTicket.graph.nodes[0].ticketIds = ['unknown'];
  assert.equal((await h.invoke(wrongTicket)).code, 400);
  assert.equal(h.calls.some(([name]) => name === 'event_funnel_save_definition'), false);
});
test('cannot publish before complete inventory and payment readiness', async () => {
  const h = harness();
  assert.equal((await h.invoke({ action: 'publish', id, expectedRevision: 1 })).code, 409);
  assert.equal(h.calls.some(([name]) => name.includes('save') || name.includes('publish')), false);
});
test('rate limiting fails closed and provides retry information', async () => {
  const h = harness({ db: { rpc: async () => ({ data: false }) } });
  const res = await h.invoke(save());
  assert.equal(res.code, 429);
  assert.equal(res.headers['Retry-After'], '60');
});
test('missing schema returns explicit unavailable response', async () => {
  const h = harness({ db: { rpc: async () => ({ error: { code: 'PGRST202' } }) } });
  assert.equal((await h.invoke(save())).code, 503);
});
test('layout cannot smuggle unknown nodes or non-finite coordinates', () => {
  assert.throws(() => validateFunnelLayout({ positions: { forged: { x: 1, y: 2 } } }, graph()));
  assert.throws(() => validateFunnelLayout({ positions: { source: { x: NaN, y: 2 } } }, graph()));
  assert.deepEqual(validateFunnelLayout({ positions: { source: { x: 1, y: 2, routing: 'forged' } } }, graph()), { positions: { source: { x: 1, y: 2 } } });
});

test('saves a guarded day re-offer and rejects the same add-on without its guard', async () => {
  const event = { id: eventId, kind: 'simple', tenantId };
  const day = (ticketId, selected) => ({ event, ticketId, selected });
  const dayGraph = () => ({ version: 1, tenantId, reservationSeconds: 900, invoiceMode: 'per_event', entry: 'source', nodes: [
    { id: 'source', type: 'source', event, ticketIds: ['three-day', 'mon', 'tue'], requires: [], accept: 'days' },
    { id: 'days', type: 'condition', rules: [
      { priority: 0, match: 'all', tests: [day('mon', true), day('tue', false)], to: 'add-tue' },
      { priority: 1, match: 'all', tests: [day('tue', true)], to: 'add-wed' },
    ], fallback: 'checkout' },
    { id: 'add-tue', type: 'addon', event, ticketIds: ['tue'], requires: ['source'], accept: 'add-wed', skip: 'add-wed' },
    { id: 'add-wed', type: 'addon', event, ticketIds: ['wed'], requires: ['source'], accept: 'checkout', skip: 'checkout' },
    { id: 'checkout', type: 'checkout' },
  ] });
  const row = { id: eventId, start_date: '2099-01-01T12:00:00Z',
    pricing_config: { ticket_classes: ['three-day', 'mon', 'tue', 'wed'].map(id => ({ id })) } };
  const h = harness({}, row);
  const ok = await h.invoke({ ...save(), graph: dayGraph() });
  assert.equal(ok.code, 200);
  const unguarded = dayGraph(); unguarded.nodes[1].rules[0].tests.pop();
  const rejected = await h.invoke({ ...save(), graph: unguarded });
  assert.equal(rejected.code, 400);
  assert.match(rejected.body.error, /not selected/);
  assert.equal(h.calls.filter(([name]) => name === 'event_funnel_save_definition').length, 1);
});
