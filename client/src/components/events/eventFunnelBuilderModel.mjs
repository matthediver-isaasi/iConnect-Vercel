import { validateFunnelGraph } from '../../../../shared/eventFunnelGraph.mjs';

export const isPurchase = node => ['source', 'event', 'addon'].includes(node.type);
export const eventKey = event => event ? JSON.stringify([event.kind, event.id]) : '';
export const eventReference = (event, tenantId) => event
  ? { id: event.id, kind: event.kind, tenantId } : null;
export const findEvent = (catalog, reference) => catalog.find(event => eventKey(event) === eventKey(reference));
export const nodeTitle = (node, catalog) => !node ? 'Missing node'
  : isPurchase(node) ? (findEvent(catalog, node.event)?.title || `Missing event: ${node.event?.id || 'choose an event'}`)
    : node.type === 'condition' ? 'Selection condition' : node.type === 'checkout' ? 'Checkout' : `Unknown type: ${node.type}`;

export function createFunnelDraft(tenantId) {
  const source = crypto.randomUUID(), checkout = crypto.randomUUID();
  return {
    id: crypto.randomUUID(), name: 'Untitled event funnel', revision: 0,
    graph: { version: 1, tenantId, reservationSeconds: 900, invoiceMode: 'per_event', entry: source, nodes: [
      { id: source, type: 'source', event: null, ticketIds: [], requires: [], accept: checkout },
      { id: checkout, type: 'checkout' },
    ] },
    layout: { positions: { [source]: { x: 100, y: 70 }, [checkout]: { x: 100, y: 350 } } },
  };
}

export const draftFingerprint = draft => JSON.stringify([draft.name, draft.graph, draft.layout]);

// "Earlier" follows connections, not array order or canvas position. A
// condition may join paths; the server remains authoritative about selection
// eligibility on the path the attendee actually takes.
export function earlierPurchaseNodes(nodes, nodeId) {
  const edges = graphConnections({ nodes });
  const walk = reverse => {
    const seen = new Set([nodeId]), pending = [nodeId];
    while (pending.length) {
      const id = pending.pop();
      for (const edge of edges) {
        const from = reverse ? edge.target : edge.source, to = reverse ? edge.source : edge.target;
        if (from === id && !seen.has(to)) { seen.add(to); pending.push(to); }
      }
    }
    return seen;
  };
  const ancestors = walk(true), descendants = walk(false);
  return nodes.filter(node => isPurchase(node) && ancestors.has(node.id) && !descendants.has(node.id));
}

export function purchaseVisibilityPatch(node, property, checked) {
  if (property === 'unlisted' && node.type === 'event'
    || property === 'funnelOnly' && ['event', 'addon'].includes(node.type)) {
    return { [property]: checked === true };
  }
  return {};
}

export function purchaseVisibilityIssues(node, nodes) {
  const issues = [];
  if (node.unlisted !== undefined && (node.type !== 'event' || typeof node.unlisted !== 'boolean')) {
    issues.push(`${node.id}: unlisted must be a boolean on an optional event only.`);
  }
  if (node.funnelOnly !== undefined && (!['event', 'addon'].includes(node.type) || typeof node.funnelOnly !== 'boolean')) {
    issues.push(`${node.id}: funnelOnly must be a boolean on an optional event or add-on only.`);
  }
  if (node.funnelOnly === true) {
    const earlier = new Set(earlierPurchaseNodes(nodes, node.id).map(other => other.id));
    if (!node.requires?.length || !node.requires.every(id => earlier.has(id))) {
      issues.push(`${node.id}: checkout-only offers require at least one connected earlier purchase in this same checkout.`);
    }
  }
  return issues;
}

export function graphIssues(graph, catalog, tenantId) {
  const issues = [];
  try { validateFunnelGraph(graph); } catch (error) { issues.push(error.message); }
  if (graph?.tenantId !== tenantId) issues.push('This definition belongs to a different tenant.');
  for (const node of graph?.nodes || []) {
    issues.push(...purchaseVisibilityIssues(node, graph.nodes));
    const references = isPurchase(node) ? [{ event: node.event, tickets: node.ticketIds || [] }]
      : (node.rules || []).flatMap(rule => (rule.tests || []).map(test => ({ event: test.event, tickets: test.ticketId ? [test.ticketId] : [] })));
    for (const reference of references) {
      const event = findEvent(catalog, reference.event);
      if (!event) issues.push(`${node.id}: event ${reference.event?.id || '(not selected)'} is missing from the catalog. The reference is preserved.`);
      else for (const id of reference.tickets) if (!(event.tickets || []).some(ticket => ticket.id === id)) {
        issues.push(`${event.title}: ticket ${id} is missing from the catalog. The reference is preserved.`);
      }
    }
  }
  return [...new Set(issues)];
}

// View-only projection. The graph's destinations, never React Flow edges, are authoritative.
export function graphConnections(graph) {
  return (graph?.nodes || []).flatMap(node => {
    const routes = node.type === 'checkout' ? [] : node.type === 'condition'
      ? [...(node.rules || []).map((rule, index) => [`rule-${index}`, rule.to, `Priority ${rule.priority} · ${rule.match}`]), ['fallback', node.fallback, 'Fallback']]
      : node.type === 'source' ? [['accept', node.accept, 'Continue']]
        : [['accept', node.accept, 'Accept'], ['skip', node.skip, 'Skip']];
    return routes.map(([handle, target, label]) => ({ source: node.id, target, sourceHandle: handle, label }));
  });
}
