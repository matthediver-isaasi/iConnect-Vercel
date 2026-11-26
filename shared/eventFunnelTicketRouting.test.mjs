import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFunnelGraph, evaluateFunnelRoute } from './eventFunnelGraph.mjs';
import { planFunnelJourneyChange } from './eventFunnelJourney.mjs';
const event = { kind: 'complex', id: 'meeting', tenantId: 'tenant' };
function graph() {
  return { version: 1, tenantId: 'tenant', entryMode: 'ticket_single', entry: 'source', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'source', type: 'source', selectionMode: 'single', event, ticketIds: ['mon', 'tue', 'wed'], requires: [], accept: 'condition' },
    { id: 'condition', type: 'condition', rules: [{ priority: 0, match: 'all',
      tests: [{ event, ticketId: 'mon', selected: true }], to: 'tuesday' }], fallback: 'checkout' },
    { id: 'tuesday', type: 'addon', selectionMode: 'single', event, ticketIds: ['tue'], requires: ['source'], accept: 'wednesday', skip: 'wednesday' },
    { id: 'wednesday', type: 'addon', selectionMode: 'single', event, ticketIds: ['wed'], requires: ['source'], accept: 'checkout', skip: 'checkout' },
    { id: 'checkout', type: 'checkout' },
  ] };
}
const select = (nodeId, id, quantity = 1) => ({ nodeId, tickets: [{ id, quantity }] });
test('a positive initial single-choice fact excludes other source classes without negative tests', () => {
  const g = graph();
  assert.deepEqual([...validateFunnelGraph(g).reofferGuards.get('tuesday').keys()], ['tue']);
  const route = evaluateFunnelRoute(g, { selections: [select('source', 'mon', 9), select('tuesday', 'tue', 3), select('wednesday', 'wed', 2)] });
  assert.equal(route.atCheckout, true);
  assert.deepEqual(route.retainedNodeIds, ['source', 'tuesday', 'wednesday']);
  assert.throws(() => evaluateFunnelRoute(g, { selections: [{ nodeId: 'source', tickets: [{ id: 'mon', quantity: 1 }, { id: 'tue', quantity: 1 }] }] }), /Invalid selected tickets/);
});
test('legacy multi-class source graphs are not reinterpreted as single-choice', () => {
  const g = graph(); delete g.entryMode; delete g.nodes[0].selectionMode;
  assert.throws(() => validateFunnelGraph(g), /not selected/);
  g.nodes[1].rules[0].tests.push({ event, ticketId: 'tue', selected: false }, { event, ticketId: 'wed', selected: false });
  assert.doesNotThrow(() => validateFunnelGraph(g));
});
test('direct Monday then Tuesday then Wednesday and Tuesday then Wednesday need no initial branch', () => {
  for (const day of ['mon', 'tue']) {
    const g = graph(); g.nodes[0].ticketIds = [day]; g.nodes[0].accept = day === 'mon' ? 'tuesday' : 'wednesday';
    g.nodes = g.nodes.filter(node => node.id !== 'condition' && (day === 'mon' || node.id !== 'tuesday'));
    assert.doesNotThrow(() => validateFunnelGraph(g));
  }
});
test('mixed earlier source/add-on attribution and unsafe joins do not infer exclusions', () => {
  const g = graph();
  g.nodes[0].accept = 'guard';
  g.nodes.push({ id: 'guard', type: 'condition', rules: [{ priority: 0, match: 'all',
    tests: [{ event, ticketId: 'tue', selected: false }], to: 'earlier' }], fallback: 'condition' });
  // This earlier re-offer is itself safe, but can invalidate a source exclusion:
  // source Monday + add-on Tuesday must not imply "Tuesday not selected".
  g.nodes.push({ id: 'earlier', type: 'addon', event, ticketIds: ['tue'], requires: ['source'], accept: 'condition', skip: 'condition' });
  assert.throws(() => validateFunnelGraph(g), /not selected/);
  const joined = graph(); joined.nodes[1].fallback = 'tuesday';
  assert.throws(() => validateFunnelGraph(joined), /not selected/);
});
test('bound initial ticket changes cannot use ordinary commands, while quantities remain supported', () => {
  const g = graph();
  const snapshot = { graph: g, holds: [], drafts: {}, serverNow: '2026-11-26T12:00:00Z',
    session: { state: 'draft', revision: 1, source_ticket_id: 'mon', expires_at: null } };
  assert.throws(() => planFunnelJourneyChange(snapshot, { type: 'select', expectedRevision: 1, nodeId: 'source', tickets: [{ id: 'tue', quantity: 1 }] }),
    { code: 'SOURCE_RESTART_REQUIRED' });
  assert.equal(planFunnelJourneyChange(snapshot, { type: 'select', expectedRevision: 1, nodeId: 'source', tickets: [{ id: 'mon', quantity: 10 }] }).selections[0].tickets[0].quantity, 10);
});
