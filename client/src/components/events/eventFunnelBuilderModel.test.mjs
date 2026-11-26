import test from 'node:test';
import assert from 'node:assert/strict';
import { createFunnelDraft, draftFingerprint, graphConnections, graphIssues, nodeTitle, earlierPurchaseNodes, selectableEvents, describeFunnelIssue,
  purchaseVisibilityPatch, purchaseVisibilityIssues, nodeLabel, nodeStepNumber } from './eventFunnelBuilderModel.mjs';

const catalog = [{ id: 'conference', kind: 'simple', title: 'Annual conference', tickets: [{ id: 'admission', name: 'Admission' }] }];
function validDraft() {
  const draft = createFunnelDraft('association');
  Object.assign(draft.graph.nodes[0], {
    event: { id: 'conference', kind: 'simple', tenantId: 'association' }, ticketIds: ['admission'],
  });
  return draft;
}

test('step labels distinguish same-event tickets and keep checkout last without changing identities', () => {
  const event = { id: 'conference', kind: 'simple', tenantId: 'association' };
  const options = [{ ...catalog[0], tickets: [...catalog[0].tickets, { id: 'dinner', name: 'Dinner' }] }];
  const nodes = [
    { id: 'checkout', type: 'checkout' },
    { id: 'source', type: 'source', event, ticketIds: ['admission'] },
    { id: 'branch', type: 'condition', name: 'Check day tickets' },
    { id: 'dinner-step', type: 'addon', event, ticketIds: ['dinner'] },
  ];
  const before = JSON.stringify(nodes);
  assert.equal(nodeLabel(nodes[1], nodes, options), 'Step 1 · Annual conference — Admission');
  assert.equal(nodeLabel(nodes[2], nodes, options), 'Step 2 · Check day tickets');
  assert.equal(nodeLabel(nodes[3], nodes, options), 'Step 3 · Annual conference — Dinner');
  assert.equal(nodeLabel(nodes[0], nodes, options), 'Step 4 · Checkout');
  assert.equal(JSON.stringify(nodes), before);
  assert.equal(nodeStepNumber({ id: 'unknown' }, nodes), null);
  assert.equal(nodeLabel(null, nodes, options), 'Unavailable destination');
  assert.equal(nodeTitle({ type: 'condition', name: '  ' }, options), 'Selection condition');
  assert.equal(nodeTitle({ type: 'condition', name: '  Named condition  ' }, options), 'Named condition');
  assert.equal(nodeTitle({ type: 'condition' }, options), 'Selection condition');
});
test('multi-ticket and unavailable references remain readable without exposing identifiers', () => {
  const node = { id: 'one', type: 'event', event: { id: 'conference', kind: 'simple' }, ticketIds: ['admission', 'missing-secret-id'] };
  assert.equal(nodeLabel(node, [node], catalog), 'Step 1 · Annual conference — Admission, Previously selected ticket unavailable');
  assert.ok(!nodeLabel(node, [node], []).includes('missing-secret-id'));
});

test('new drafts have independent IDs, revision zero and layout separate from graph', () => {
  const first = createFunnelDraft('association'), second = createFunnelDraft('association');
  assert.notEqual(first.id, second.id);
  assert.equal(first.revision, 0);
  assert.deepEqual(first.graph.nodes.map(node => node.type), ['source', 'checkout']);
  assert.equal(first.graph.entry, first.graph.nodes[0].id);
  assert.equal(first.graph.nodes[0].accept, first.graph.nodes[1].id);
  assert.ok(first.layout.positions[first.graph.entry]);
  assert.equal(first.graph.nodes[0].position, undefined);
});

test('catalog validation reports missing references without modifying the saved graph', () => {
  const draft = validDraft(), before = JSON.stringify(draft);
  assert.deepEqual(graphIssues(draft.graph, catalog, 'association'), []);
  assert.ok(graphIssues(draft.graph, [], 'association').some(issue => issue.includes('selection is preserved')));
  assert.equal(JSON.stringify(draft), before);
  assert.equal(nodeTitle(draft.graph.nodes[0], []), 'Previously selected event unavailable');
  assert.ok(graphIssues(draft.graph, [], 'association').every(issue => !issue.includes('conference')));
});

test('ticket references remain visible and cross-tenant drafts cannot save', () => {
  const draft = validDraft();
  draft.graph.nodes[0].ticketIds.push('removed-parking');
  assert.ok(graphIssues(draft.graph, catalog, 'association').some(issue => issue.includes('selection is preserved')));
  assert.ok(graphIssues(draft.graph, catalog, 'association').every(issue => !issue.includes('removed-parking')));
  assert.ok(graphIssues(draft.graph, catalog, 'other').some(issue => issue.includes('current organization')));
});

test('view connections reflect authoritative domain destinations and preserve missing targets', () => {
  const draft = validDraft();
  draft.graph.nodes.push({ id: 'branch', type: 'condition', rules: [{ priority: 7, match: 'any', tests: [], to: 'missing-offer' }], fallback: draft.graph.nodes[1].id });
  const before = JSON.stringify(draft.graph);
  const connections = graphConnections(draft.graph);
  assert.ok(connections.some(edge => edge.sourceHandle === 'rule-0' && edge.target === 'missing-offer' && edge.label.includes('Rule 1')));
  assert.ok(connections.some(edge => edge.sourceHandle === 'fallback'));
  assert.equal(JSON.stringify(draft.graph), before);
});

test('fingerprint includes layout and edits but excludes server revision metadata', () => {
  const draft = validDraft(), before = draftFingerprint(draft);
  draft.revision = 8; draft.published_version_id = 'published-version';
  assert.equal(draftFingerprint(draft), before);
  draft.layout.positions[draft.graph.entry].x += 12;
  assert.notEqual(draftFingerprint(draft), before);
});

test('inspector flags are explicit, type-scoped edits and do not normalize absent legacy properties', () => {
  const draft = validDraft(), source = draft.graph.nodes[0], before = draftFingerprint(draft);
  assert.deepEqual(purchaseVisibilityPatch(source, 'unlisted', true), {});
  assert.deepEqual(purchaseVisibilityPatch(source, 'funnelOnly', true), {});
  assert.deepEqual(purchaseVisibilityPatch({ type: 'addon' }, 'unlisted', true), {});
  assert.deepEqual(purchaseVisibilityPatch({ type: 'event' }, 'unlisted', true), { unlisted: true });
  assert.deepEqual(purchaseVisibilityPatch({ type: 'addon' }, 'funnelOnly', false), { funnelOnly: false });
  purchaseVisibilityIssues(source, draft.graph.nodes);
  assert.equal(Object.hasOwn(source, 'unlisted'), false);
  assert.equal(Object.hasOwn(source, 'funnelOnly'), false);
  assert.equal(draftFingerprint(draft), before);
});

test('same-checkout prerequisites follow connection order, not array order', () => {
  const nodes = [
    { id: 'later', type: 'event', accept: 'checkout', skip: 'checkout', requires: [] },
    { id: 'offer', type: 'event', accept: 'later', skip: 'checkout', requires: ['source'], funnelOnly: true },
    { id: 'source', type: 'source', accept: 'offer', requires: [] },
    { id: 'checkout', type: 'checkout' },
  ];
  assert.deepEqual(earlierPurchaseNodes(nodes, 'offer').map(node => node.id), ['source']);
  assert.deepEqual(purchaseVisibilityIssues(nodes[1], nodes), []);
  assert.ok(purchaseVisibilityIssues({ ...nodes[1], requires: [] }, nodes).some(issue => issue.includes('earlier purchase')));
  assert.ok(purchaseVisibilityIssues({ ...nodes[1], requires: ['later'] }, nodes).length > 0);
  assert.ok(purchaseVisibilityIssues({ ...nodes[0], unlisted: 'yes' }, nodes).length > 0);
});

test('event choices are alphabetical, omit unavailable events, and retain existing event titles', () => {
  const events = [
    { id: 'old', kind: 'simple', title: 'Alumni dinner', selectable: false },
    { id: 'z', kind: 'simple', title: 'Workshop' },
    { id: 'a', kind: 'simple', title: 'Annual meeting' },
  ];
  assert.deepEqual(selectableEvents(events).map(event => event.title), ['Annual meeting', 'Workshop']);
  assert.equal(nodeTitle({ type: 'source', event: { id: 'old', kind: 'simple' } }, events), 'Alumni dinner');
});

test('validation display replaces internal node and catalog references with human labels', () => {
  const graph = { nodes: [{ id: 'opaque-node-key', type: 'source', event: { id: 'conference-key', kind: 'simple' } }] };
  const eventCatalog = [{ id: 'conference-key', kind: 'simple', title: 'Annual conference' }];
  const readable = describeFunnelIssue('opaque-node-key points to conference-key', graph, eventCatalog);
  assert.equal(readable, 'Annual conference points to Annual conference');
  assert.ok(!readable.includes('opaque-node-key'));
  assert.ok(!readable.includes('conference-key'));
});

test('membership stage titles, issues and tier switching never expose tier identifiers', async () => {
  const { membershipStageIssues, membershipStagePatch } = await import('./eventFunnelBuilderModel.mjs');
  const id = '00000000-0000-4000-8000-000000000011';
  const tiers = [{ id, name: 'Individual', scope: 'member', active: true }, { id: 'org', name: 'Corporate', scope: 'organization', active: false }];
  const node = { id: 'm', type: 'membership', membership: { scheduleId: id, scope: 'member', recipientMode: 'attendees', description: 'Hi' } };
  assert.equal(nodeTitle(node, [], tiers), 'Complimentary membership: Individual');
  assert.equal(nodeTitle({ ...node, membership: { scheduleId: 'gone' } }, [], tiers), 'Complimentary membership: unavailable tier');
  assert.deepEqual(membershipStageIssues(node, tiers), []);
  const missing = membershipStageIssues({ ...node, membership: { ...node.membership, scheduleId: 'gone' } }, tiers);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].includes('gone'), false);
  assert.match(membershipStageIssues({ ...node, membership: { scheduleId: 'org', scope: 'organization', recipientMode: 'purchaser' } }, tiers)[0], /inactive/);
  assert.deepEqual(membershipStagePatch(node, tiers[1]).membership, { scheduleId: 'org', scope: 'organization', recipientMode: 'purchaser', description: 'Hi' });
  assert.equal(membershipStagePatch(node, tiers[0]).membership.recipientMode, 'attendees');
});

test('guarded day re-offers explain their condition and unguarded ones explain the fix', async () => {
  const { reofferNotes } = await import('./eventFunnelBuilderModel.mjs');
  const event = { id: 'meeting', kind: 'simple', tenantId: 'association' };
  const days = [{ id: 'mon', name: 'Monday Non-member' }, { id: 'tue', name: 'Tuesday Non-member' }, { id: 'wed', name: 'Wednesday Non-member' }];
  const meeting = [{ id: 'meeting', kind: 'simple', title: 'Spring Meeting', tickets: days }];
  const graph = { version: 1, tenantId: 'association', entry: 'src', reservationSeconds: 900, invoiceMode: 'per_event', nodes: [
    { id: 'src', type: 'source', event, ticketIds: ['mon', 'tue'], requires: [], accept: 'cond' },
    { id: 'cond', type: 'condition', rules: [
      { priority: 0, match: 'all', tests: [{ event, ticketId: 'mon', selected: true }, { event, ticketId: 'tue', selected: false }], to: 'tue-addon' },
      { priority: 1, match: 'all', tests: [{ event, ticketId: 'tue', selected: true }], to: 'wed-addon' },
    ], fallback: 'out' },
    { id: 'tue-addon', type: 'addon', event, ticketIds: ['tue'], requires: ['src'], accept: 'wed-addon', skip: 'wed-addon' },
    { id: 'wed-addon', type: 'addon', event, ticketIds: ['wed'], requires: ['src'], accept: 'out', skip: 'out' },
    { id: 'out', type: 'checkout' },
  ] };
  assert.deepEqual(graphIssues(graph, meeting, 'association'), []);
  const notes = reofferNotes(graph, 'tue-addon', meeting);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Tuesday Non-member is also offered earlier/);
  assert.deepEqual(reofferNotes(graph, 'wed-addon', meeting), []);
  graph.nodes[1].rules[0].tests.pop();
  const [issue] = graphIssues(graph, meeting, 'association');
  assert.match(issue, /Spring Meeting offers Tuesday Non-member again/);
  assert.match(issue, /Tuesday Non-member is not selected/);
  assert.ok(!issue.includes('tue-addon') && !/\btue\b/.test(issue));
});
