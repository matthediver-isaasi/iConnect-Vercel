import test from 'node:test';
import assert from 'node:assert/strict';
import { planFunnelJourneyChange, readFunnelJourney } from './eventFunnelJourney.mjs';

export const journeyGraph = () => {
  const event = id => ({ kind: 'simple', id, tenantId: 'tenant' });
  return { version: 1, tenantId: 'tenant', entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'source', type: 'source', event: event('admission'), ticketIds: ['A', 'B'], requires: [], accept: 'branch' },
    { id: 'branch', type: 'condition', rules: [{ priority: 1, match: 'any', tests: [
      { event: event('admission'), ticketId: 'B', selected: true },
    ], to: 'dinner' }], fallback: 'parking' },
    { id: 'parking', type: 'addon', event: event('admission'), ticketIds: ['P'], requires: ['source'], accept: 'other', skip: 'other' },
    { id: 'dinner', type: 'addon', event: event('admission'), ticketIds: ['D'], requires: ['source'], accept: 'other', skip: 'other' },
    { id: 'other', type: 'event', event: event('conference'), ticketIds: ['C'], requires: [], accept: 'lunch', skip: 'checkout' },
    { id: 'lunch', type: 'addon', event: event('conference'), ticketIds: ['L'], requires: ['other'], accept: 'checkout', skip: 'checkout' },
    { id: 'checkout', type: 'checkout' },
  ] };
};
export function journeyFixture(selection = [['source', 'A'], ['parking', 'P'], ['other', 'C'], ['lunch', 'L']]) {
  const graph = journeyGraph();
  return {
    graph, session: { revision: 5, state: 'held', expires_at: '2030-01-01T00:15:00Z',
      journey: { version: 1, decisions: {}, checkoutNow: false } },
    serverNow: '2030-01-01T00:01:00Z',
    holds: selection.map(([id, ticket, quantity = 1]) => {
      const node = graph.nodes.find(n => n.id === id);
      return { node_id: id, ticket_id: ticket, quantity, places: quantity, event_kind: node.event.kind, event_id: node.event.id,
        price_snapshot: { unitMinor: 1000, currency: 'GBP' } };
    }), drafts: { source: { name: 'Saved attendee' }, other: { name: 'Other attendee' } },
  };
}
const select = (nodeId, id, quantity = 1) => ({ type: 'select', expectedRevision: 5, nodeId, tickets: [{ id, quantity }] });
test('source back edit removes the old branch but keeps a shared later event and its answers pending', () => {
  const snapshot = journeyFixture();
  const before = structuredClone(snapshot);
  const result = planFunnelJourneyChange(snapshot, select('source', 'B'));
  assert.deepEqual(result.removed.map(r => r.nodeId), ['parking']);
  assert.equal(result.route.currentNodeId, 'dinner');
  assert.deepEqual(result.route.pendingNodeIds, ['other', 'lunch']);
  assert.deepEqual(result.selections.map(s => s.nodeId), ['source', 'other', 'lunch']);
  assert.deepEqual(snapshot, before);
});
test('skipping an upstream event removes its dependent add-on and never the source', () => {
  const result = planFunnelJourneyChange(journeyFixture(), { type: 'skip', nodeId: 'other', expectedRevision: 5 });
  assert.deepEqual(result.removed.map(r => r.nodeId), ['other', 'lunch']);
  assert.equal(result.route.atCheckout, true);
  assert.deepEqual(result.journey.decisions, { other: 'skip' });
});
test('source-only checkout prunes every optional selection explicitly', () => {
  const result = planFunnelJourneyChange(journeyFixture(), { type: 'source_only', expectedRevision: 5 });
  assert.deepEqual(result.selections.map(s => s.nodeId), ['source']);
  assert.deepEqual(result.route.route, ['source', 'checkout']);
  assert.equal(result.removed.length, 3);
});
test('resume offers after source-only checkout does not restore released tickets', () => {
  const snapshot = journeyFixture([['source', 'A']]);
  snapshot.session.journey.checkoutNow = true;
  const result = planFunnelJourneyChange(snapshot, { type: 'resume_offers', expectedRevision: 5 });
  assert.equal(result.route.currentNodeId, 'parking');
  assert.equal(result.selections.length, 1);
});
test('no selecting an alternative branch or a pending later offer before the current decision', () => {
  assert.throws(() => planFunnelJourneyChange(journeyFixture(), select('dinner', 'D')), { code: 'OFFER_UNREACHABLE' });
  const snapshot = journeyFixture([['source', 'B'], ['other', 'C'], ['lunch', 'L']]);
  assert.throws(() => planFunnelJourneyChange(snapshot, select('other', 'C', 2)), { code: 'OFFER_UNREACHABLE' });
});
test('a skipped prerequisite cannot be forged into eligibility', () => {
  const snapshot = journeyFixture([['source', 'A'], ['parking', 'P']]);
  snapshot.session.journey.decisions.other = 'skip';
  assert.throws(() => planFunnelJourneyChange(snapshot, select('lunch', 'L')), { code: 'OFFER_UNREACHABLE' });
  assert.throws(() => planFunnelJourneyChange(snapshot, { type: 'skip', nodeId: 'source', expectedRevision: 5 }));
});
test('stale tabs, payment states, and forged authority fields fail closed', () => {
  for (const extra of [{ nextNodeId: 'checkout' }, { priceSnapshot: { unitMinor: 0 } }, { memberId: 'someone' }, { expectedRevision: 4 }]) {
    assert.throws(() => planFunnelJourneyChange(journeyFixture(), { ...select('source', 'A'), ...extra }));
  }
  for (const state of ['payable', 'confirming', 'payment_uncertain', 'confirmed', 'cancelled']) {
    const snapshot = journeyFixture(); snapshot.session.state = state;
    assert.throws(() => planFunnelJourneyChange(snapshot, select('source', 'A')), { code: 'CHECKOUT_FROZEN' });
  }
});
test('server time, not client time, determines expiry and explicit re-reservation', () => {
  const snapshot = journeyFixture();
  assert.throws(() => planFunnelJourneyChange(snapshot, { type: 'rereserve', expectedRevision: 5 }), { code: 'RESERVATION_ACTIVE' });
  snapshot.serverNow = snapshot.session.expires_at;
  assert.throws(() => planFunnelJourneyChange(snapshot, select('source', 'A')), { code: 'RESERVATION_EXPIRED' });
  const result = planFunnelJourneyChange(snapshot, { type: 'rereserve', expectedRevision: 5 });
  assert.equal(result.rereserve, true);
  assert.equal(result.selections.length, 4);
  const sourceOnly = planFunnelJourneyChange(snapshot, { type: 'source_only', expectedRevision: 5 });
  assert.equal(sourceOnly.rereserve, false);
  assert.deepEqual(sourceOnly.selections.map(s => s.nodeId), ['source']);
});
test('source selection can start a draft without a deadline; answers are cloned', () => {
  const snapshot = journeyFixture([]);
  snapshot.session.state = 'draft'; snapshot.session.expires_at = null;
  const command = { ...select('source', 'A'), answers: { attendee: { name: 'Test' } } };
  const plan = planFunnelJourneyChange(snapshot, command);
  command.answers.attendee.name = 'Changed';
  assert.equal(plan.answers.attendee.name, 'Test');
  assert.equal(plan.answerNode, 'source');
  assert.equal(plan.route.currentNodeId, 'parking');
});
test('invalid quantities and duplicate stored lines cannot silently change the route', () => {
  for (const quantity of [0, -1, 1.1, 10001, '1', NaN]) {
    assert.throws(() => planFunnelJourneyChange(journeyFixture(), select('source', 'A', quantity)));
  }
  const snapshot = journeyFixture(); snapshot.holds.push(snapshot.holds[0]);
  assert.throws(() => readFunnelJourney(snapshot), { code: 'JOURNEY_UNAVAILABLE' });
});
