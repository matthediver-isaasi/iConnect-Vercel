import { evaluateFunnelRoute, validateFunnelGraph } from './eventFunnelGraph.mjs';

export class FunnelJourneyError extends Error {
  constructor(message, code = 'INVALID_SELECTION', status = 400) {
    super(message); this.name = 'FunnelJourneyError'; this.code = code; this.status = status;
  }
}
const reject = (message, code, status) => { throw new FunnelJourneyError(message, code, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const set = (value, key, entry) => Object.defineProperty(value, key, { value: entry, enumerable: true, configurable: true, writable: true });

export function readFunnelJourney(snapshot) {
  if (!object(snapshot?.session) || !Array.isArray(snapshot.holds)
    || !Number.isSafeInteger(snapshot.session.revision) || snapshot.session.revision < 1) {
    reject('Unable to read your saved selection.', 'JOURNEY_UNAVAILABLE', 503);
  }
  const { nodes } = validateFunnelGraph(snapshot.graph);
  const journey = snapshot.session.journey ?? { version: 1, decisions: {}, checkoutNow: false };
  if (!fields(journey, ['version', 'decisions', 'checkoutNow']) || journey.version !== 1
    || !object(journey.decisions) || typeof journey.checkoutNow !== 'boolean') {
    reject('Unable to read your saved route.', 'JOURNEY_UNAVAILABLE', 503);
  }
  const selections = new Map(), lineKeys = new Set();
  for (const hold of snapshot.holds) {
    const node = nodes.get(hold?.node_id);
    if (!node?.event || node.event.kind !== hold.event_kind || node.event.id !== hold.event_id
      || !node.ticketIds.includes(hold.ticket_id)
      || !Number.isSafeInteger(hold.quantity) || hold.quantity < 1 || hold.quantity > 10000) {
      reject('Unable to read your saved tickets.', 'JOURNEY_UNAVAILABLE', 503);
    }
    const key = JSON.stringify([hold.node_id, hold.ticket_id]);
    if (lineKeys.has(key)) reject('Duplicate saved tickets.', 'JOURNEY_UNAVAILABLE', 503);
    lineKeys.add(key);
    if (!selections.has(node.id)) selections.set(node.id, { nodeId: node.id, tickets: [] });
    selections.get(node.id).tickets.push({ id: hold.ticket_id, quantity: hold.quantity });
  }
  const route = evaluateFunnelRoute(snapshot.graph, { selections: [...selections.values()], ...journey });
  return { selections, journey: structuredClone(journey), route, nodes };
}

/**
 * Client commands identify a selection, never a destination, a price, a tenant
 * or a prerequisite entitlement. The service supplies the owned DB snapshot.
 * This pure plan does not change inventory; its complete result must commit
 * with the expected revision in one transaction.
 */
export function planFunnelJourneyChange(snapshot, command) {
  const { selections, journey, route: before, nodes } = readFunnelJourney(snapshot);
  if (!fields(command, ['type', 'expectedRevision', 'nodeId', 'tickets', 'answers', 'decision'])
    || !['select', 'skip', 'membership', 'source_only', 'resume_offers', 'rereserve'].includes(command.type)
    || (command.decision !== undefined && command.type !== 'membership')) {
    reject('Invalid selection change.');
  }
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== snapshot.session.revision) {
    reject('Your selection changed in another tab. Reload before continuing.', 'REVISION_CONFLICT', 409);
  }
  if (!['draft', 'held', 'expired'].includes(snapshot.session.state)) {
    reject('This checkout is already being processed.', 'CHECKOUT_FROZEN', 409);
  }
  const now = Date.parse(snapshot.serverNow);
  const expires = snapshot.session.expires_at == null ? null : Date.parse(snapshot.session.expires_at);
  if (!Number.isFinite(now) || (expires !== null && !Number.isFinite(expires))) {
    reject('Unable to verify the reservation time.', 'JOURNEY_UNAVAILABLE', 503);
  }
  const expired = snapshot.session.state === 'expired' || (expires !== null && expires <= now);
  if (expired && !['rereserve', 'skip', 'membership', 'source_only', 'resume_offers'].includes(command.type)) {
    reject('Your reservation expired. Check availability and prices again before changing tickets.', 'RESERVATION_EXPIRED', 409);
  }
  if (command.type === 'rereserve' && !expired) reject('A live reservation cannot be extended.', 'RESERVATION_ACTIVE', 409);
  const original = new Set(selections.keys());
  let answerNode = null, answers = null;
  const membershipNode = nodes.get(command.nodeId)?.type === 'membership';
  if (command.type === 'membership' || (command.type === 'skip' && membershipNode)) {
    // Accept/decline a complimentary membership offer: no tickets, no price.
    const node = nodes.get(command.nodeId);
    const index = before.route.indexOf(command.nodeId);
    if (!membershipNode || index < 0 || !node.requires.every(id =>
      before.retainedNodeIds.includes(id) && before.route.indexOf(id) < index)) {
      reject('This offer is not available from your current selections.', 'OFFER_UNREACHABLE', 409);
    }
    const decision = command.type === 'skip' ? 'skip' : command.decision;
    if (!['accept', 'skip'].includes(decision) || command.tickets !== undefined || command.answers !== undefined) {
      reject('Invalid membership offer answer.');
    }
    set(journey.decisions, node.id, decision);
  } else if (command.type === 'select' || command.type === 'skip') {
    const node = nodes.get(command.nodeId);
    const index = before.route.indexOf(command.nodeId);
    if (!node?.event || index < 0 || !node.requires.every(id =>
      before.retainedNodeIds.includes(id) && before.route.indexOf(id) < index)) {
      reject('This offer is not available from your current selections.', 'OFFER_UNREACHABLE', 409);
    }
    if (command.type === 'skip') {
      if (node.type === 'source') reject('Keep the source event to continue.');
      if (command.tickets !== undefined || command.answers !== undefined) reject('Invalid skip request.');
      selections.delete(node.id);
      set(journey.decisions, node.id, 'skip');
    } else {
      if (!Array.isArray(command.tickets) || !command.tickets.length || command.tickets.length > 100
        || command.tickets.some(ticket => !fields(ticket, ['id', 'quantity'])
          || !node.ticketIds.includes(ticket.id) || !Number.isSafeInteger(ticket.quantity)
          || ticket.quantity < 1 || ticket.quantity > 10000)
        || new Set(command.tickets.map(ticket => ticket.id)).size !== command.tickets.length) reject('Choose valid ticket quantities.');
      if (command.answers !== undefined) {
        if (!object(command.answers) || JSON.stringify(command.answers).length > 65536) reject('Invalid attendee answers.');
        answerNode = node.id; answers = structuredClone(command.answers);
      }
      delete journey.decisions[node.id];
      selections.set(node.id, { nodeId: node.id, tickets: structuredClone(command.tickets) });
    }
  } else {
    if (command.nodeId !== undefined || command.tickets !== undefined || command.answers !== undefined) reject('Unexpected selection details.');
    if (!selections.has(snapshot.graph.entry)) reject('Choose your source tickets first.');
    if (command.type === 'source_only') { journey.checkoutNow = true; journey.decisions = {}; }
    if (command.type === 'resume_offers') journey.checkoutNow = false;
  }
  let route = evaluateFunnelRoute(snapshot.graph, { selections: [...selections.values()], ...journey });
  const keep = new Set([...route.retainedNodeIds, ...route.pendingNodeIds]);
  for (const id of selections.keys()) if (!keep.has(id)) selections.delete(id);
  const removed = [...original].filter(id => !selections.has(id)).map(nodeId => ({
    nodeId,
    reason: command.type === 'source_only' ? 'You chose to continue with the source event only.'
      : command.type === 'skip' && command.nodeId === nodeId ? 'You removed this optional selection.'
        : 'This selection is no longer reachable from your current choices.',
  }));
  // Re-evaluate the pruned set so response route and persisted selection agree.
  route = evaluateFunnelRoute(snapshot.graph, { selections: [...selections.values()], ...journey });
  return {
    expectedRevision: command.expectedRevision, selections: [...selections.values()],
    journey, route, removed, answerNode, answers, rereserve: command.type === 'rereserve',
  };
}
