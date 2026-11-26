import { validateFunnelGraph } from '../../../../shared/eventFunnelGraph.mjs';

export const isPurchase = node => ['source', 'event', 'addon'].includes(node.type);
export const eventKey = event => event ? JSON.stringify([event.kind, event.id]) : '';
export const eventReference = (event, tenantId) => event
  ? { id: event.id, kind: event.kind, tenantId } : null;
export const findEvent = (catalog, reference) => catalog.find(event => eventKey(event) === eventKey(reference));
export const selectableEvents = catalog => catalog
  .filter(event => event.selectable !== false)
  .slice()
  .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
export const findMembershipTier = (tiers, node) => (tiers || []).find(tier => tier.id === node?.membership?.scheduleId);
// Membership stage titles use the tier name only, never its identifier.
export const nodeTitle = (node, catalog, tiers = []) => !node ? 'Unavailable destination'
  : isPurchase(node) ? (findEvent(catalog, node.event)?.title || 'Previously selected event unavailable')
    : node.type === 'membership' ? `Complimentary membership: ${findMembershipTier(tiers, node)?.name || (node.membership?.scheduleId ? 'unavailable tier' : 'choose a tier')}`
    : node.type === 'condition' ? 'Selection condition' : node.type === 'checkout' ? 'Checkout' : 'Unsupported funnel step';

export function describeFunnelIssue(issue, graph, catalog = [], tiers = []) {
  let message = String(issue || 'Review this funnel step.');
  const nodes = graph?.nodes || [];
  for (const node of graph?.nodes || []) {
    if (node.id) message = message.replaceAll(node.id, nodeTitle(node, catalog, tiers));
    if (node.membership?.scheduleId) message = message.replaceAll(node.membership.scheduleId,
      findMembershipTier(tiers, node)?.name || 'an unavailable membership tier');
    for (const requiredId of node.requires || []) {
      if (!nodes.some(other => other.id === requiredId)) message = message.replaceAll(requiredId, 'an unavailable earlier offer');
    }
    for (const rule of node.rules || []) {
      for (const test of rule.tests || []) {
        if (test.event?.id && !findEvent(catalog, test.event)) message = message.replaceAll(test.event.id, 'an unavailable event');
        if (test.ticketId && !findEvent(catalog, test.event)?.tickets?.some(ticket => ticket.id === test.ticketId)) {
          message = message.replaceAll(test.ticketId, 'an unavailable ticket');
        }
      }
    }
    for (const ref of [node.accept, node.skip, node.fallback, ...(node.rules || []).map(rule => rule.to)]) {
      if (ref && !nodes.some(other => other.id === ref)) message = message.replaceAll(ref, 'an unavailable destination');
    }
    for (const ticketId of node.ticketIds || []) {
      const event = findEvent(catalog, node.event);
      if (!event?.tickets?.some(ticket => ticket.id === ticketId)) message = message.replaceAll(ticketId, 'an unavailable ticket');
    }
    if (node.event?.id && !findEvent(catalog, node.event)) message = message.replaceAll(node.event.id, 'an unavailable event');
  }
  for (const event of catalog) {
    if (event.id) message = message.replaceAll(event.id, event.title || 'event');
    for (const ticket of event.tickets || []) {
      if (ticket.id) message = message.replaceAll(ticket.id, ticket.name || 'ticket');
    }
  }
  return message
    .replace(/\b(?:event|ticket) \((?:not selected|missing)\)/gi, 'Choose an event or ticket')
    .replace(/Unknown type: [^.;]+/g, 'Unsupported funnel step')
    .replace(/node [\w-]+/gi, 'funnel step')
    .replace(/\b[a-f0-9]{8}-[a-f0-9-]{20,}\b/gi, 'a saved funnel step');
}

/**
 * Explains why an add-on may re-offer a ticket that an earlier step offers:
 * every route into it passes a condition requiring that ticket to be not
 * selected. Returns no notes for invalid graphs; their issues are reported.
 */
export function reofferNotes(graph, nodeId, catalog = []) {
  let guards;
  try { guards = validateFunnelGraph(graph).reofferGuards.get(nodeId); } catch { return []; }
  if (!guards) return [];
  const node = graph.nodes.find(item => item.id === nodeId);
  const tickets = findEvent(catalog, node?.event)?.tickets || [];
  return [...guards].map(([ticketId, conditionIds]) => {
    const name = tickets.find(ticket => ticket.id === ticketId)?.name || 'This ticket';
    const count = conditionIds.length === 1 ? 'a selection condition' : `${conditionIds.length} selection conditions`;
    return `${name} is also offered earlier. It is offered again here only because every route passes ${count} requiring it to be not selected, so it cannot be bought twice.`;
  });
}

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
    issues.push('The unlisted setting is only available for optional events.');
  }
  if (node.funnelOnly !== undefined && (!['event', 'addon'].includes(node.type) || typeof node.funnelOnly !== 'boolean')) {
    issues.push('The checkout-only setting is only available for optional events and add-ons.');
  }
  if (node.funnelOnly === true) {
    const earlier = new Set(earlierPurchaseNodes(nodes, node.id).map(other => other.id));
    if (!node.requires?.length || !node.requires.every(id => earlier.has(id))) {
      issues.push('Checkout-only offers need at least one connected earlier purchase in this checkout.');
    }
  }
  return issues;
}

export function membershipStageIssues(node, tiers) {
  if (node.type !== 'membership') return [];
  const issues = [];
  if (!node.membership?.scheduleId) return ['Complimentary membership: choose a membership tier.'];
  const tier = findMembershipTier(tiers, node);
  if (!tier) issues.push('Complimentary membership: the previously selected membership tier is no longer available. Its saved selection is preserved; choose another tier before saving or previewing.');
  else {
    if (!tier.active) issues.push(`${tier.name}: this membership tier is inactive. Its saved selection is preserved; choose an active tier before saving or previewing.`);
    if (tier.scope !== node.membership.scope) issues.push(`${tier.name}: this tier changed between organisation and individual membership. Choose the tier again.`);
  }
  return issues;
}

export function membershipStagePatch(node, tier) {
  const scope = tier?.scope === 'member' ? 'member' : 'organization';
  const previous = node.membership || {};
  return { membership: {
    scheduleId: tier?.id || '', scope,
    recipientMode: scope === 'organization' ? 'purchaser' : previous.recipientMode === 'attendees' ? 'attendees' : 'purchaser',
    ...(previous.description ? { description: previous.description } : {}),
  } };
}

export function graphIssues(graph, catalog, tenantId, tiers = []) {
  const issues = [];
  try { validateFunnelGraph(graph); } catch (error) { issues.push(describeFunnelIssue(error.message, graph, catalog, tiers)); }
  if (graph?.tenantId !== tenantId) issues.push('This funnel is not available to the current organization.');
  for (const node of graph?.nodes || []) {
    issues.push(...purchaseVisibilityIssues(node, graph.nodes));
    issues.push(...membershipStageIssues(node, tiers));
    const references = isPurchase(node) ? [{ event: node.event, tickets: node.ticketIds || [] }]
      : (node.rules || []).flatMap(rule => (rule.tests || []).map(test => ({ event: test.event, tickets: test.ticketId ? [test.ticketId] : [] })));
    for (const reference of references) {
      const event = findEvent(catalog, reference.event);
      if (!event) issues.push(`${nodeTitle(node, catalog)}: a previously selected event is no longer available in the event list. Its saved selection is preserved.`);
      else {
        if (event.selectable === false) issues.push(`${event.title}: choose a future event that has not been completed or cancelled. Its saved selection is preserved.`);
        for (const id of reference.tickets) if (!(event.tickets || []).some(ticket => ticket.id === id)) {
          issues.push(`${event.title}: a previously selected ticket is no longer available. Its saved selection is preserved.`);
        }
      }
    }
  }
  return [...new Set(issues)];
}

// View-only projection. The graph's destinations, never React Flow edges, are authoritative.
export function graphConnections(graph) {
  return (graph?.nodes || []).flatMap(node => {
    const routes = node.type === 'checkout' ? [] : node.type === 'condition'
      ? [...(node.rules || []).map((rule, index) => [`rule-${index}`, rule.to, `Rule ${index + 1} · ${rule.match === 'any' ? 'any answer matches' : 'all answers match'}`]), ['fallback', node.fallback, 'If no rule matches']]
      : node.type === 'source' ? [['accept', node.accept, 'Continue']]
        : [['accept', node.accept, 'Accept'], ['skip', node.skip, 'Skip']];
    return routes.map(([handle, target, label]) => ({ source: node.id, target, sourceHandle: handle, label }));
  });
}
