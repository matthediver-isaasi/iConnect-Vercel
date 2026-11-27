import { funnelPresentationIssue } from './eventFunnelPresentation.mjs';

/**
 * Version-one domain graph, independent of React Flow positions and edges.
 * This pure evaluator does NOT authorize purchases or reserve inventory.
 * Runtime callers must supply server-owned, eligibility-checked selections.
 */
export class FunnelGraphError extends Error {
  constructor(message) { super(message); this.name = 'FunnelGraphError'; }
}
const fail = message => { throw new FunnelGraphError(message); };
const key = event => JSON.stringify([event.kind, event.id]);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const isEvent = event => event && ['simple', 'complex'].includes(event.kind) && identifier(event.id);
const purchasing = node => ['source', 'event', 'addon'].includes(node.type);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Complimentary membership offer: a non-purchasing, non-charging stage. It
 * grants eligibility for one base-fee period only after a confirmed checkout;
 * conditions can never reference it and it never reserves inventory.
 */
export function validateMembershipStage(node) {
  const m = node.membership;
  if (!m || typeof m !== 'object' || Array.isArray(m)
    || Object.keys(m).some(field => !['scheduleId', 'scope', 'recipientMode', 'description'].includes(field))) {
    fail('Membership stages require a membership tier');
  }
  if (!uuid(m.scheduleId)) fail('Membership stages require a membership tier');
  if (!['organization', 'member'].includes(m.scope)) fail('Invalid membership tier type');
  if (m.scope === 'organization' ? m.recipientMode !== 'purchaser' : !['purchaser', 'attendees'].includes(m.recipientMode)) {
    fail('Invalid membership recipient');
  }
  if (m.description != null && (typeof m.description !== 'string' || m.description.length > 1000)) {
    fail('Membership descriptions must be 1000 characters or fewer');
  }
  if (!Array.isArray(node.requires) || node.requires.some(id => !identifier(id))
    || new Set(node.requires).size !== node.requires.length) fail('Invalid prerequisites');
  if (['event', 'ticketIds', 'unlisted', 'funnelOnly'].some(field => node[field] !== undefined)) {
    fail('Membership stages cannot sell tickets');
  }
}
const destinations = node => node.type === 'checkout' ? []
  : node.type === 'condition' ? [...node.rules.map(rule => rule.to), node.fallback]
    : node.type === 'source' ? [node.accept] : [node.accept, node.skip];

export function validateFunnelGraph(graph) {
  if (!graph || graph.version !== 1 || !identifier(graph.tenantId)) fail('Invalid graph version or tenant');
  if (graph.entryMode !== undefined && graph.entryMode !== 'ticket_single') fail('Invalid entry mode');
  if (!Number.isInteger(graph.reservationSeconds) || graph.reservationSeconds < 60 || graph.reservationSeconds > 3600) {
    fail('Reservation duration must be between 60 and 3600 seconds');
  }
  if (!['per_event', 'consolidated'].includes(graph.invoiceMode)) fail('Invalid invoice mode');
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > 100) fail('A graph requires 1–100 nodes');
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!node || !identifier(node.id) || nodes.has(node.id)) fail('Invalid or duplicate node ID');
    if (!['source', 'event', 'addon', 'membership', 'condition', 'checkout'].includes(node.type)) fail('Unknown node type');
    const presentationIssue = funnelPresentationIssue(node);
    if (presentationIssue) fail(presentationIssue);
    nodes.set(node.id, node);
    if (node.type === 'membership') validateMembershipStage(node);
    if (purchasing(node)) {
      if (node.selectionMode !== undefined && !['single', 'multiple'].includes(node.selectionMode)) fail('Invalid ticket selection mode');
      if (graph.entryMode === 'ticket_single' && node.type === 'source' && node.selectionMode !== 'single') {
        fail('Ticket-routed funnels require a single-choice source');
      }
      if (!isEvent(node.event) || node.event.tenantId !== graph.tenantId) fail('Invalid or cross-tenant event');
      if (!Array.isArray(node.ticketIds) || !node.ticketIds.length || node.ticketIds.length > 100
        || node.ticketIds.some(id => !identifier(id)) || new Set(node.ticketIds).size !== node.ticketIds.length) {
        fail('Each purchase node requires distinct ticket IDs');
      }
      if (!Array.isArray(node.requires) || node.requires.some(id => !identifier(id))
        || new Set(node.requires).size !== node.requires.length) fail('Invalid prerequisites');
      if (node.type === 'source' && node.requires.length) fail('Source cannot require another purchase');
      if (node.unlisted != null && (typeof node.unlisted !== 'boolean' || node.type !== 'event')) {
        fail('Only an optional event can change calendar visibility');
      }
      if (node.funnelOnly != null && (typeof node.funnelOnly !== 'boolean' || node.type === 'source')) {
        fail('Only optional offers can require a same-checkout purchase');
      }
      if (node.funnelOnly && !node.requires.length) fail('Same-checkout offers require at least one prerequisite');
    }
    if (node.type === 'condition') {
      if (node.name !== undefined && (typeof node.name !== 'string' || node.name.length > 120)) {
        fail('Condition names must be 120 characters or fewer');
      }
      if (!Array.isArray(node.rules) || !node.rules.length || node.rules.length > 100) fail('Conditions require rules');
      const priorities = new Set();
      for (const rule of node.rules) {
        if (!rule || !Number.isInteger(rule.priority) || rule.priority < 0 || priorities.has(rule.priority)) fail('Rule priorities must be distinct non-negative integers');
        priorities.add(rule.priority);
        if (!['any', 'all'].includes(rule.match) || !Array.isArray(rule.tests) || !rule.tests.length || rule.tests.length > 100) fail('Invalid any/all condition');
        for (const test of rule.tests) {
          if (!test || !isEvent(test.event) || test.event.tenantId !== graph.tenantId || typeof test.selected !== 'boolean'
            || (test.ticketId !== undefined && !identifier(test.ticketId))) fail('Invalid selection condition');
        }
      }
    }
  }
  const sources = graph.nodes.filter(node => node.type === 'source');
  const checkouts = graph.nodes.filter(node => node.type === 'checkout');
  if (sources.length !== 1 || sources[0].id !== graph.entry || checkouts.length !== 1) fail('Exactly one source and checkout are required');
  for (const node of graph.nodes) {
    if (destinations(node).some(id => !nodes.has(id))) fail('Missing destination or fallback');
    for (const id of node.requires || []) {
      if (!purchasing(nodes.get(id) || {}) || id === node.id) fail('Invalid purchase prerequisite');
    }
  }
  const visiting = new Set(), visited = new Set(), order = [];
  function visit(id) {
    if (visiting.has(id)) fail('Graph contains a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of destinations(nodes.get(id))) visit(next);
    visiting.delete(id); visited.add(id); order.unshift(id);
  }
  visit(graph.entry);
  if (visited.size !== nodes.size) fail('Graph contains unreachable nodes');
  // Propagate potential ancestors (not full paths: joins must remain bounded),
  // plus "not selected" facts that hold on EVERY route reaching a node.
  const ancestors = new Map(order.map(id => [id, new Set()]));
  const facts = new Map([[graph.entry, new Map()]]);
  const reofferGuards = new Map();
  for (const id of order) {
    const node = nodes.get(id), prior = ancestors.get(id), known = facts.get(id) || new Map();
    for (const required of node.requires || []) {
      if (!prior.has(required)) fail('Prerequisites must be earlier purchases');
    }
    if (node.type === 'addon' && !(node.requires || []).some(required =>
      ['source', 'event'].includes(nodes.get(required).type) && key(nodes.get(required).event) === key(node.event))) {
      fail('An add-on requires an earlier purchase of the same event');
    }
    if (purchasing(node)) {
      for (const previousId of prior) {
        const previous = nodes.get(previousId);
        if (!purchasing(previous) || key(previous.event) !== key(node.event)) continue;
        if (node.type !== 'addon') fail('A purchasing path contains duplicate event or ticket offers');
        for (const ticket of previous.ticketIds.filter(ticket => node.ticketIds.includes(ticket))) {
          const origins = excludedBy(known, node.event, ticket);
          if (!origins) {
            fail(`The add-on ${node.id} offers ${ticket} again after an earlier step offers it. `
              + `Every route into this add-on must pass a condition rule that continues only when ${ticket} is not selected.`);
          }
          const guards = reofferGuards.get(id) || new Map();
          guards.set(ticket, [...new Set([...(guards.get(ticket) || []), ...origins])]);
          reofferGuards.set(id, guards);
        }
      }
    }
    if (node.type === 'condition') {
      for (const rule of node.rules) for (const test of rule.tests) {
        if (![...prior].some(previousId => {
          const previous = nodes.get(previousId);
          return purchasing(previous) && key(previous.event) === key(test.event)
            && (test.ticketId === undefined || previous.ticketIds.includes(test.ticketId));
        })) fail('Conditions may reference only earlier offered selections');
      }
    }
    // Positive tests imply exclusions only when exactly one earlier offer can
    // account for the tested ticket, and no other earlier offer could hold the
    // excluded ticket. This deliberately loses information at unsafe joins.
    const implied = test => {
      if (!test.selected || !test.ticketId) return new Map();
      const offers = [...prior].map(id => nodes.get(id)).filter(previous =>
        purchasing(previous) && key(previous.event) === key(test.event));
      const origins = offers.filter(previous => previous.ticketIds.includes(test.ticketId));
      if (origins.length !== 1 || origins[0].selectionMode !== 'single') return new Map();
      return new Map(origins[0].ticketIds.filter(ticket => ticket !== test.ticketId
        && !offers.some(other => other.id !== origins[0].id && other.ticketIds.includes(ticket)))
        .map(ticket => [factKey(test.event, ticket), new Set([node.id])]));
    };
    for (const [next, established] of edgeFacts(node, known, implied)) {
      const target = ancestors.get(next);
      target.add(id);
      for (const previous of prior) target.add(previous);
      facts.set(next, facts.has(next) ? intersectFacts(facts.get(next), established) : established);
    }
  }
  return { nodes, checkoutId: checkouts[0].id, order, reofferGuards };
}

// A fact means "no selection retained so far on this route includes this
// ticket" (or any ticket of the event, for '*'). Values are the condition
// steps that establish it.
const factKey = (event, ticket) => JSON.stringify([event.kind, event.id, ticket ?? '*']);
function excludedBy(known, event, ticket) {
  const origins = [...(known.get(factKey(event, ticket)) || []), ...(known.get(factKey(event)) || [])];
  return known.has(factKey(event, ticket)) || known.has(factKey(event)) ? [...new Set(origins)] : null;
}
const unionFacts = (...sets) => {
  const result = new Map();
  for (const set of sets) for (const [fact, origins] of set) result.set(fact, new Set([...(result.get(fact) || []), ...origins]));
  return result;
};
function intersectFacts(...sets) {
  if (!sets.length) return new Map();
  const result = new Map();
  for (const [fact] of sets[0]) {
    if (sets.every(set => set.has(fact))) result.set(fact, new Set(sets.flatMap(set => [...set.get(fact)])));
  }
  return result;
}
// A test establishes exclusion when it requires "not selected" and holds, or
// requires "selected" and is known to have failed.
const testFacts = (test, holds, origin, implied) => test.selected !== holds
  ? new Map([[factKey(test.event, test.ticketId), new Set([origin])]])
  : holds && test.selected ? implied(test) : new Map();
const ruleMatched = (rule, origin, implied) => rule.match === 'all'
  ? unionFacts(...rule.tests.map(test => testFacts(test, true, origin, implied)))
  : intersectFacts(...rule.tests.map(test => testFacts(test, true, origin, implied)));
const ruleFailed = (rule, origin, implied) => rule.match === 'all'
  ? intersectFacts(...rule.tests.map(test => testFacts(test, false, origin, implied)))
  : unionFacts(...rule.tests.map(test => testFacts(test, false, origin, implied)));
function edgeFacts(node, known, implied) {
  if (node.type === 'checkout') return [];
  if (node.type === 'condition') {
    const sorted = [...node.rules].sort((a, b) => a.priority - b.priority);
    const edges = sorted.map((rule, index) => [rule.to, unionFacts(known, ruleMatched(rule, node.id, implied),
      ...sorted.slice(0, index).map(earlier => ruleFailed(earlier, node.id, implied)))]);
    return [...edges, [node.fallback, unionFacts(known, ...sorted.map(rule => ruleFailed(rule, node.id, implied)))]];
  }
  if (node.type === 'membership') return [[node.accept, known], [node.skip, known]];
  // Accepting an offer may retain any of its tickets; skipping retains none.
  const accepted = new Map([...known].filter(([fact]) => {
    const [kind, eventId, ticket] = JSON.parse(fact);
    return kind !== node.event.kind || eventId !== node.event.id || (ticket !== '*' && !node.ticketIds.includes(ticket));
  }));
  return node.type === 'source' ? [[node.accept, accepted]] : [[node.accept, accepted], [node.skip, known]];
}

/** Tickets of the same event that each retained selection already holds. */
function heldTickets(nodes, selected, ids) {
  const held = new Set();
  for (const id of ids) for (const ticket of selected.get(id).tickets) held.add(factKey(nodes.get(id).event, ticket.id));
  return held;
}
const overlaps = (node, selection, held) => selection.tickets.some(ticket => held.has(factKey(node.event, ticket.id)));


/**
 * Selections: [{nodeId, tickets:[{id, quantity}]}]; decisions: {nodeId:'skip'}
 * for purchase offers, {nodeId:'accept'|'skip'} for membership offers.
 * Only selections encountered on the current route can satisfy conditions.
 * Unanswered offers pause traversal; missing prerequisites automatically skip.
 */
export function evaluateFunnelRoute(graph, { selections = [], decisions = {}, checkoutNow = false } = {}) {
  const { nodes, checkoutId, order } = validateFunnelGraph(graph);
  if (typeof checkoutNow !== 'boolean') fail('Invalid checkout decision');
  if (!Array.isArray(selections) || selections.length > graph.nodes.length) fail('Invalid selections');
  const selected = new Map();
  for (const selection of selections) {
    const node = nodes.get(selection?.nodeId);
    if (!node || !purchasing(node) || selected.has(node.id)) fail('Unknown or duplicate purchase selection');
    if (!Array.isArray(selection.tickets) || !selection.tickets.length
      || node.selectionMode === 'single' && selection.tickets.length !== 1
      || new Set(selection.tickets.map(ticket => ticket?.id)).size !== selection.tickets.length
      || selection.tickets.some(ticket => !ticket || !node.ticketIds.includes(ticket.id)
        || !Number.isSafeInteger(ticket.quantity) || ticket.quantity <= 0)) fail('Invalid selected tickets');
    selected.set(node.id, selection);
  }
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) fail('Invalid decisions');
  for (const [id, decision] of Object.entries(decisions)) {
    const type = nodes.get(id)?.type;
    if (!(type === 'membership' ? ['accept', 'skip'].includes(decision) : ['event', 'addon'].includes(type) && decision === 'skip')) {
      fail('Invalid skip decision');
    }
    if (selected.has(id)) fail('A selected offer cannot also be skipped');
  }
  const route = [], retained = new Set(), matchedRules = [], accepted = [], conflicts = new Set();
  let current = graph.entry;
  const matches = test => {
    const found = [...retained].some(id => {
      const node = nodes.get(id);
      return key(node.event) === key(test.event)
        && (test.ticketId === undefined || selected.get(id).tickets.some(ticket => ticket.id === test.ticketId));
    });
    return test.selected ? found : !found;
  };
  while (current) {
    const node = nodes.get(current);
    route.push(current);
    if (node.type === 'checkout') break;
    if (node.type === 'condition') {
      const rule = [...node.rules].sort((a, b) => a.priority - b.priority)
        .find(rule => rule.match === 'all' ? rule.tests.every(matches) : rule.tests.some(matches));
      matchedRules.push({ nodeId: node.id, priority: rule?.priority ?? null });
      current = rule?.to ?? node.fallback;
    } else {
      if (!node.requires.every(id => retained.has(id))) { current = node.skip; continue; }
      if (node.type === 'membership') {
        if (decisions[current] === 'accept') { accepted.push(current); current = node.accept; }
        else if (decisions[current] === 'skip') current = node.skip;
        else break;
        continue;
      }
      if (selected.has(current) && overlaps(node, selected.get(current), heldTickets(nodes, selected, retained))) {
        // Defence in depth: never retain a ticket twice for the same event,
        // even if a stored definition bypassed authoring validation.
        conflicts.add(current);
        break;
      }
      if (selected.has(current)) {
        retained.add(current);
        // Source-only checkout deliberately removes every optional selection.
        current = checkoutNow && node.type === 'source' ? checkoutId : node.accept;
      } else if (decisions[current] === 'skip') current = node.skip;
      else break;
    }
  }
  // A newly encountered unanswered offer must not erase an already held shared
  // later purchase. Preserve potentially reachable drafts until its answer
  // resolves the route; they are NOT yet eligible for payable checkout.
  const pending = new Set();
  if (route.at(-1) !== checkoutId) {
    const possible = new Set();
    const collect = id => {
      if (possible.has(id)) return;
      possible.add(id);
      for (const next of destinations(nodes.get(id))) collect(next);
    };
    collect(route.at(-1));
    for (const id of selected.keys()) if (possible.has(id) && !retained.has(id) && !conflicts.has(id)) pending.add(id);
    let changed;
    do {
      changed = false;
      for (const id of pending) {
        if (!nodes.get(id).requires.every(required => retained.has(required) || pending.has(required))) {
          pending.delete(id); changed = true;
        }
      }
    } while (changed);
    // A pending draft may never duplicate a held ticket of the same event.
    const held = heldTickets(nodes, selected, retained);
    for (const id of order.filter(candidate => pending.has(candidate))) {
      if (overlaps(nodes.get(id), selected.get(id), held)) { pending.delete(id); conflicts.add(id); continue; }
      for (const ticket of selected.get(id).tickets) held.add(factKey(nodes.get(id).event, ticket.id));
    }
    do {
      changed = false;
      for (const id of pending) {
        if (!nodes.get(id).requires.every(required => retained.has(required) || pending.has(required))) {
          pending.delete(id); changed = true;
        }
      }
    } while (changed);
  }
  return {
    route, matchedRules, currentNodeId: route.at(-1),
    atCheckout: route.at(-1) === checkoutId,
    retainedNodeIds: [...retained],
    // Accepted offers are eligibility requests only; checkout re-verifies them.
    acceptedMembershipNodeIds: route.at(-1) === checkoutId ? accepted : [],
    pendingNodeIds: [...pending],
    removed: [...selected.keys()].filter(id => !retained.has(id) && !pending.has(id)).map(nodeId => ({
      nodeId, reason: conflicts.has(nodeId) ? 'These tickets are already included earlier in your selection.'
        : 'This selection is no longer reachable from your current choices.',
    })),
  };
}
