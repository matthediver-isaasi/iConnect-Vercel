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
const destinations = node => node.type === 'checkout' ? []
  : node.type === 'condition' ? [...node.rules.map(rule => rule.to), node.fallback]
    : node.type === 'source' ? [node.accept] : [node.accept, node.skip];

export function validateFunnelGraph(graph) {
  if (!graph || graph.version !== 1 || !identifier(graph.tenantId)) fail('Invalid graph version or tenant');
  if (!Number.isInteger(graph.reservationSeconds) || graph.reservationSeconds < 60 || graph.reservationSeconds > 3600) {
    fail('Reservation duration must be between 60 and 3600 seconds');
  }
  if (!['per_event', 'consolidated'].includes(graph.invoiceMode)) fail('Invalid invoice mode');
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > 100) fail('A graph requires 1–100 nodes');
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!node || !identifier(node.id) || nodes.has(node.id)) fail('Invalid or duplicate node ID');
    if (!['source', 'event', 'addon', 'condition', 'checkout'].includes(node.type)) fail('Unknown node type');
    nodes.set(node.id, node);
    if (purchasing(node)) {
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
  // Propagate potential ancestors (not full paths: joins must remain bounded).
  const ancestors = new Map(order.map(id => [id, new Set()]));
  for (const id of order) {
    const node = nodes.get(id), prior = ancestors.get(id);
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
        if (node.type !== 'addon' || previous.ticketIds.some(ticket => node.ticketIds.includes(ticket))) {
          fail('A purchasing path contains duplicate event or ticket offers');
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
    for (const next of destinations(node)) {
      const target = ancestors.get(next);
      target.add(id);
      for (const previous of prior) target.add(previous);
    }
  }
  return { nodes, checkoutId: checkouts[0].id };
}

/**
 * Selections: [{nodeId, tickets:[{id, quantity}]}]; decisions: {nodeId:'skip'}.
 * Only selections encountered on the current route can satisfy conditions.
 * Unanswered offers pause traversal; missing prerequisites automatically skip.
 */
export function evaluateFunnelRoute(graph, { selections = [], decisions = {}, checkoutNow = false } = {}) {
  const { nodes, checkoutId } = validateFunnelGraph(graph);
  if (typeof checkoutNow !== 'boolean') fail('Invalid checkout decision');
  if (!Array.isArray(selections) || selections.length > graph.nodes.length) fail('Invalid selections');
  const selected = new Map();
  for (const selection of selections) {
    const node = nodes.get(selection?.nodeId);
    if (!node || !purchasing(node) || selected.has(node.id)) fail('Unknown or duplicate purchase selection');
    if (!Array.isArray(selection.tickets) || !selection.tickets.length
      || new Set(selection.tickets.map(ticket => ticket?.id)).size !== selection.tickets.length
      || selection.tickets.some(ticket => !ticket || !node.ticketIds.includes(ticket.id)
        || !Number.isSafeInteger(ticket.quantity) || ticket.quantity <= 0)) fail('Invalid selected tickets');
    selected.set(node.id, selection);
  }
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) fail('Invalid decisions');
  for (const [id, decision] of Object.entries(decisions)) {
    if (!['event', 'addon'].includes(nodes.get(id)?.type) || decision !== 'skip') fail('Invalid skip decision');
    if (selected.has(id)) fail('A selected offer cannot also be skipped');
  }
  const route = [], retained = new Set(), matchedRules = [];
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
    for (const id of selected.keys()) if (possible.has(id) && !retained.has(id)) pending.add(id);
    let changed;
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
    pendingNodeIds: [...pending],
    removed: [...selected.keys()].filter(id => !retained.has(id) && !pending.has(id)).map(nodeId => ({
      nodeId, reason: 'This selection is no longer reachable from your current choices.',
    })),
  };
}
