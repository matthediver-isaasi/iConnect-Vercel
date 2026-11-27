// Pure helpers for the funnel checkout cart. Display and preview only: the
// server re-plans every change and remains the authority for what is removed.
import { planFunnelJourneyChange } from '../../../shared/eventFunnelJourney.mjs';

const fullName = attendee => `${attendee?.first_name || attendee?.firstName || ''} ${attendee?.last_name || attendee?.lastName || ''}`.trim()
  || attendee?.email || '';

function attendeesFor(snapshot, nodeId, ticketId) {
  const draft = snapshot?.drafts?.[nodeId] || {};
  const byTicket = draft.attendeesByTicket && typeof draft.attendeesByTicket === 'object' ? draft.attendeesByTicket : null;
  const list = byTicket ? byTicket[String(ticketId)] : draft.attendees;
  return Array.isArray(list) ? list.map(fullName).filter(Boolean) : [];
}

/**
 * Cart rows in route order. Rows whose step requires an earlier optional step
 * (not just the original event) are nested under it, so chains are visible.
 */
export function funnelCartRows(snapshot, lines = []) {
  const nodes = new Map((snapshot?.graph?.nodes || []).map(node => [node.id, node]));
  const entry = snapshot?.graph?.entry;
  const route = snapshot?.route?.route || [];
  const position = id => { const index = route.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  const inCart = new Set(lines.map(line => line.nodeId));
  const titles = new Map(lines.map(line => [line.nodeId, line.ticketName || line.eventTitle]));
  const depthCache = new Map();
  const parentsOf = id => (nodes.get(id)?.requires || []).filter(required => required !== entry && inCart.has(required));
  const depth = (id, seen = new Set()) => {
    if (depthCache.has(id)) return depthCache.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const value = parentsOf(id).reduce((max, parent) => Math.max(max, depth(parent, seen) + 1), 0);
    depthCache.set(id, value);
    return value;
  };
  // Depth-first: each step is followed by the steps that depend on it.
  const ordered = [...new Set(lines.map(line => line.nodeId))].sort((a, b) => position(a) - position(b));
  const placed = [];
  const visit = id => {
    if (placed.includes(id)) return;
    placed.push(id);
    ordered.filter(child => !placed.includes(child) && parentsOf(child).at(-1) === id).forEach(visit);
  };
  ordered.filter(id => parentsOf(id).length === 0).forEach(visit);
  ordered.forEach(visit);
  return placed.flatMap(nodeId => {
    const node = nodes.get(nodeId);
    const nodeLines = lines.filter(line => line.nodeId === nodeId);
    return nodeLines.map((line, index) => ({
      key: `${line.nodeId}:${line.ticketId}`,
      line,
      nodeId,
      depth: depth(nodeId),
      kind: nodeId === entry || node?.type === 'source' ? 'source' : node?.type === 'addon' ? 'addon' : 'event',
      requires: parentsOf(nodeId).map(parent => titles.get(parent)).filter(Boolean),
      attendees: attendeesFor(snapshot, nodeId, line.ticketId),
      // One removal per step: skipping a step releases all of its tickets.
      removable: index === 0 && nodeId !== entry && node?.type !== 'source',
      stepLineCount: nodeLines.length,
    }));
  });
}

/**
 * Runs the same pure planner the server uses for a skip, so the confirmation
 * names every dependent selection that would also be released. Returns null
 * when the outcome cannot be predicted; the server still decides.
 */
export function previewFunnelRemoval(snapshot, nodeId) {
  try {
    const plan = planFunnelJourneyChange(snapshot, { type: 'skip', nodeId, expectedRevision: snapshot.session.revision });
    return {
      alsoRemoved: plan.removed.map(item => item.nodeId).filter(id => id !== nodeId),
      leavesCheckout: !plan.route.atCheckout,
    };
  } catch {
    return null;
  }
}
