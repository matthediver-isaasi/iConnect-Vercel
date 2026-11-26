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

test('membership offers accept or decline without tickets, including after the hold expires', () => {
  const snapshot = journeyFixture([['source', 'A']]);
  snapshot.graph.nodes.find(node => node.id === 'source').accept = 'member';
  snapshot.graph.nodes.splice(1, 0, { id: 'member', type: 'membership', requires: ['source'], accept: 'branch', skip: 'branch',
    membership: { scheduleId: '00000000-0000-4000-8000-000000000011', scope: 'member', recipientMode: 'purchaser' } });
  assert.equal(readFunnelJourney(snapshot).route.currentNodeId, 'member');
  const accepted = planFunnelJourneyChange(snapshot, { type: 'membership', expectedRevision: 5, nodeId: 'member', decision: 'accept' });
  assert.equal(accepted.journey.decisions.member, 'accept');
  assert.equal(accepted.route.currentNodeId, 'parking');
  assert.deepEqual(accepted.selections.map(s => s.nodeId), ['source']);
  snapshot.session.state = 'expired';
  const declined = planFunnelJourneyChange(snapshot, { type: 'skip', expectedRevision: 5, nodeId: 'member' });
  assert.equal(declined.journey.decisions.member, 'skip');
  assert.throws(() => planFunnelJourneyChange(snapshot, { type: 'membership', expectedRevision: 5, nodeId: 'member', decision: 'maybe' }));
  assert.throws(() => planFunnelJourneyChange(snapshot, { type: 'membership', expectedRevision: 5, nodeId: 'parking', decision: 'accept' }));
  assert.throws(() => planFunnelJourneyChange(snapshot, { type: 'select', expectedRevision: 5, nodeId: 'source', decision: 'accept', tickets: [{ id: 'A', quantity: 1 }] }));
});

// Multi-day re-offer: Tuesday is offered at the source and again as an add-on
// for Monday-only buyers. Holds are unique per event ticket.
function dayFixture(selection) {
  const event = { kind: 'simple', id: 'meeting', tenantId: 'tenant' };
  const day = (ticketId, selected) => ({ event, ticketId, selected });
  const graph = { version: 1, tenantId: 'tenant', entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'source', type: 'source', event, ticketIds: ['three-day', 'mon', 'tue'], requires: [], accept: 'days' },
    { id: 'days', type: 'condition', rules: [
      { priority: 0, match: 'all', tests: [day('mon', true), day('tue', false)], to: 'add-tue' },
      { priority: 1, match: 'all', tests: [day('tue', true)], to: 'add-wed' },
    ], fallback: 'checkout' },
    { id: 'add-tue', type: 'addon', event, ticketIds: ['tue'], requires: ['source'], accept: 'add-wed', skip: 'add-wed' },
    { id: 'add-wed', type: 'addon', event, ticketIds: ['wed'], requires: ['source'], accept: 'checkout', skip: 'checkout' },
    { id: 'checkout', type: 'checkout' },
  ] };
  return { graph, session: { revision: 5, state: 'held', expires_at: '2030-01-01T00:15:00Z',
    journey: { version: 1, decisions: {}, checkoutNow: false } }, serverNow: '2030-01-01T00:01:00Z', drafts: {},
  holds: selection.map(([node_id, ticket_id]) => ({ node_id, ticket_id, quantity: 1, places: 1, event_kind: 'simple',
    event_id: 'meeting', price_snapshot: { unitMinor: 1000, currency: 'GBP' } })) };
}
test('Monday buyers can add Tuesday and then Wednesday', async () => {
  const { assertFunnelCheckoutSelections } = await import('./eventFunnelJourney.mjs');
  const added = planFunnelJourneyChange(dayFixture([['source', 'mon']]), select('add-tue', 'tue'));
  assert.equal(added.route.currentNodeId, 'add-wed');
  const done = dayFixture([['source', 'mon'], ['add-tue', 'tue'], ['add-wed', 'wed']]);
  assert.doesNotThrow(() => assertFunnelCheckoutSelections(readFunnelJourney(done)));
});
test('adding Tuesday at the source releases the Tuesday add-on in the same change', () => {
  const result = planFunnelJourneyChange(dayFixture([['source', 'mon'], ['add-tue', 'tue'], ['add-wed', 'wed']]),
    { type: 'select', expectedRevision: 5, nodeId: 'source', tickets: [{ id: 'mon', quantity: 1 }, { id: 'tue', quantity: 1 }] });
  assert.deepEqual(result.selections.map(s => s.nodeId), ['source', 'add-wed']);
  assert.deepEqual(result.removed.map(r => r.nodeId), ['add-tue']);
  assert.equal(result.route.atCheckout, true);
  const tickets = result.selections.flatMap(s => s.tickets.map(t => t.id));
  assert.equal(new Set(tickets).size, tickets.length);
});
test('a Tuesday add-on cannot be selected when Tuesday is already held earlier', () => {
  // Tuesday buyers never reach the Tuesday add-on.
  assert.throws(() => planFunnelJourneyChange(dayFixture([['source', 'tue']]), select('add-tue', 'tue')),
    error => error.code === 'OFFER_UNREACHABLE');
});
test('checkout refuses held lines outside the retained route or duplicated tickets', async () => {
  const { assertFunnelCheckoutSelections } = await import('./eventFunnelJourney.mjs');
  const journey = readFunnelJourney(dayFixture([['source', 'tue'], ['add-wed', 'wed']]));
  assert.doesNotThrow(() => assertFunnelCheckoutSelections(journey));
  const forged = { ...journey, route: { ...journey.route, retainedNodeIds: [...journey.route.retainedNodeIds, 'add-tue'] },
    selections: new Map([...journey.selections, ['add-tue', { nodeId: 'add-tue', tickets: [{ id: 'tue', quantity: 1 }] }]]) };
  assert.throws(() => assertFunnelCheckoutSelections(forged), error => error.code === 'DUPLICATE_TICKET');
  const stray = { ...journey, selections: new Map([...journey.selections, ['add-tue', { nodeId: 'add-tue', tickets: [{ id: 'tue', quantity: 1 }] }]]) };
  assert.throws(() => assertFunnelCheckoutSelections(stray), error => error.code === 'REVISION_CONFLICT');
});
