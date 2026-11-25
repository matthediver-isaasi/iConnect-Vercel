import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFunnelGraph, evaluateFunnelRoute } from './eventFunnelGraph.mjs';

const event = id => ({ id, kind: 'simple', tenantId: 'tenant' });
const purchase = (id, type, eventId, ticketIds, accept, skip, requires = []) =>
  ({ id, type, event: event(eventId), ticketIds, accept, skip, requires });
const selection = (nodeId, ...tickets) => ({ nodeId, tickets: tickets.map(id => ({ id, quantity: 1 })) });
function graph() {
  return { version: 1, tenantId: 'tenant', entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    purchase('source', 'source', 'admission', ['standard', 'premium'], 'branch'),
    { id: 'branch', type: 'condition', rules: [
      { priority: 20, match: 'all', tests: [{ event: event('admission'), ticketId: 'standard', selected: true }], to: 'parking' },
      { priority: 10, match: 'any', tests: [{ event: event('admission'), ticketId: 'premium', selected: true }], to: 'dinner' },
    ], fallback: 'second' },
    purchase('parking', 'addon', 'admission', ['parking'], 'second', 'second', ['source']),
    purchase('dinner', 'addon', 'admission', ['dinner'], 'second', 'second', ['source']),
    purchase('second', 'event', 'second-event', ['entry'], 'lunch', 'checkout'),
    purchase('lunch', 'addon', 'second-event', ['lunch'], 'checkout', 'checkout', ['second']),
    { id: 'checkout', type: 'checkout' },
  ] };
}
test('priority resolves multiple selected classes independently of rule array order', () => {
  const result = evaluateFunnelRoute(graph(), { selections: [selection('source', 'standard', 'premium')] });
  assert.equal(result.currentNodeId, 'dinner');
  assert.equal(result.matchedRules[0].priority, 10);
});
test('back edits prune obsolete offers but preserve shared later selections', () => {
  const result = evaluateFunnelRoute(graph(), {
    selections: [selection('source', 'premium'), selection('parking', 'parking'), selection('second', 'entry'), selection('lunch', 'lunch')],
    decisions: { dinner: 'skip' },
  });
  assert.equal(result.atCheckout, true);
  assert.deepEqual(result.retainedNodeIds, ['source', 'second', 'lunch']);
  assert.deepEqual(result.removed.map(row => row.nodeId), ['parking']);
});
test('source-only route removes all optional selections', () => {
  const result = evaluateFunnelRoute(graph(), { selections: [selection('source', 'standard'), selection('parking', 'parking')], checkoutNow: true });
  assert.deepEqual(result.route, ['source', 'checkout']);
  assert.deepEqual(result.retainedNodeIds, ['source']);
});
test('an unanswered replacement offer preserves shared downstream drafts', () => {
  const result = evaluateFunnelRoute(graph(), {
    selections: [selection('source', 'premium'), selection('parking', 'parking'), selection('second', 'entry'), selection('lunch', 'lunch')],
  });
  assert.equal(result.currentNodeId, 'dinner');
  assert.equal(result.atCheckout, false);
  assert.deepEqual(result.pendingNodeIds, ['second', 'lunch']);
  assert.deepEqual(result.removed.map(row => row.nodeId), ['parking']);
});
test('source-only cannot bypass an unanswered source', () => {
  assert.equal(evaluateFunnelRoute(graph(), { checkoutNow: true }).atCheckout, false);
});
test('skipping an event removes its dependent selections', () => {
  const result = evaluateFunnelRoute(graph(), {
    selections: [selection('source', 'standard'), selection('lunch', 'lunch')],
    decisions: { parking: 'skip', second: 'skip' },
  });
  assert.equal(result.atCheckout, true);
  assert.deepEqual(result.removed.map(row => row.nodeId), ['lunch']);
});
test('negative predicates and fallback are explicit', () => {
  const definition = graph();
  definition.nodes[1].rules = [{ priority: 0, match: 'all', tests: [
    { event: event('admission'), ticketId: 'premium', selected: false },
    { event: event('admission'), ticketId: 'standard', selected: true },
  ], to: 'parking' }, definition.nodes[1].rules[1]];
  // Keep all nodes structurally reachable, while making the premium rule not match.
  definition.nodes[1].rules[1].tests[0].selected = false;
  assert.equal(evaluateFunnelRoute(definition, { selections: [selection('source', 'premium')] }).currentNodeId, 'second');
});
for (const [name, mutate] of [
  ['cycle', g => { g.nodes[2].accept = 'branch'; }],
  ['broken destination', g => { g.nodes[2].skip = 'missing'; }],
  ['missing fallback', g => { delete g.nodes[1].fallback; }],
  ['unreachable node', g => { g.nodes.push({ id: 'orphan', type: 'checkout' }); }],
  ['cross tenant', g => { g.nodes[0].event.tenantId = 'other'; }],
  ['overlapping ticket path', g => { g.nodes[2].ticketIds = ['standard']; }],
  ['priority tie', g => { g.nodes[1].rules[1].priority = 20; }],
  ['future predicate', g => { g.nodes[1].rules[0].tests[0].event = event('second-event'); }],
  ['unowned add-on', g => { g.nodes[5].requires = ['source']; }],
  ['invalid timer', g => { g.reservationSeconds = 0; }],
  ['null rule', g => { g.nodes[1].rules = [null]; }],
  ['null predicate', g => { g.nodes[1].rules[0].tests = [null]; }],
]) test(`rejects ${name}`, () => {
  const definition = graph(); mutate(definition);
  assert.throws(() => validateFunnelGraph(definition));
});
test('rejects forged ticket, quantity, destination and contradictory decision', () => {
  assert.throws(() => evaluateFunnelRoute(graph(), { selections: [selection('source', 'forged')] }));
  assert.throws(() => evaluateFunnelRoute(graph(), { selections: [{ nodeId: 'source', tickets: [{ id: 'standard', quantity: 0 }] }] }));
  assert.throws(() => evaluateFunnelRoute(graph(), { decisions: { branch: 'checkout' } }));
  assert.throws(() => evaluateFunnelRoute(graph(), { selections: [selection('parking', 'parking')], decisions: { parking: 'skip' } }));
});
test('evaluation does not mutate persisted definition or selections', () => {
  const definition = graph(), input = { selections: [selection('source', 'standard')] };
  const before = JSON.stringify({ definition, input });
  evaluateFunnelRoute(definition, input);
  assert.equal(JSON.stringify({ definition, input }), before);
});

const TIER = '00000000-0000-4000-8000-000000000011';
const membership = (overrides = {}) => ({ id: 'member', type: 'membership', requires: ['source'], accept: 'checkout', skip: 'checkout',
  membership: { scheduleId: TIER, scope: 'member', recipientMode: 'attendees', description: 'Join us' }, ...overrides });
function membershipGraph(node = membership()) {
  return { version: 1, tenantId: 'tenant', entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    purchase('source', 'source', 'admission', ['standard'], 'member'), node, { id: 'checkout', type: 'checkout' },
  ] };
}
test('membership stage pauses until answered and reports accepted offers only at checkout', () => {
  const selections = [selection('source', 'standard')];
  const paused = evaluateFunnelRoute(membershipGraph(), { selections });
  assert.equal(paused.currentNodeId, 'member');
  assert.deepEqual(paused.acceptedMembershipNodeIds, []);
  const accepted = evaluateFunnelRoute(membershipGraph(), { selections, decisions: { member: 'accept' } });
  assert.equal(accepted.atCheckout, true);
  assert.deepEqual(accepted.acceptedMembershipNodeIds, ['member']);
  const declined = evaluateFunnelRoute(membershipGraph(), { selections, decisions: { member: 'skip' } });
  assert.deepEqual(declined.acceptedMembershipNodeIds, []);
  assert.equal(declined.atCheckout, true);
});
test('membership stage validation rejects invalid tiers, recipients and ticket fields', () => {
  assert.doesNotThrow(() => validateFunnelGraph(membershipGraph()));
  const invalid = [
    membership({ membership: { scope: 'member', recipientMode: 'purchaser' } }),
    membership({ membership: { scheduleId: TIER, scope: 'organization', recipientMode: 'attendees' } }),
    membership({ membership: { scheduleId: TIER, scope: 'member', recipientMode: 'everyone' } }),
    membership({ membership: { scheduleId: TIER, scope: 'member', recipientMode: 'purchaser', description: 'x'.repeat(1001) } }),
    membership({ ticketIds: ['standard'] }),
  ];
  for (const node of invalid) assert.throws(() => validateFunnelGraph(membershipGraph(node)));
  assert.throws(() => evaluateFunnelRoute(membershipGraph(), { selections: [selection('source', 'standard')], decisions: { member: 'maybe' } }));
  assert.throws(() => evaluateFunnelRoute(membershipGraph(), { selections: [selection('source', 'standard')], decisions: { source: 'accept' } }));
});
