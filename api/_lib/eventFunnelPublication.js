import { loadFunnelCommercialAuthority, snapshotFunnelTicket } from './eventFunnelCommercial.js';
import { funnelMembershipEnabled } from './funnelMembershipRollout.js';

// Publication records server-owned catalogue evidence, not purchaser eligibility.
// Checkout still re-resolves prices, access, tax and payment authority for the
// actual purchaser; this snapshot never authorizes a booking by itself.
export async function buildFunnelPublicationSnapshot({ db, tenantId, graph, references,
  loadAuthority = loadFunnelCommercialAuthority, membershipEnabled = funnelMembershipEnabled }) {
  if (graph.nodes.some(node => node.type === 'membership') && !membershipEnabled()) {
    throw Object.assign(new Error('Membership offers are not enabled in this application release.'), { status: 503 });
  }
  const authority = await loadAuthority(db, tenantId);
  const offers = graph.nodes.filter(node => node.event).map(node => {
    const reference = references.get(`${node.event.kind}:${node.event.id}`);
    if (!reference) throw Object.assign(new Error('An event is no longer available.'), { status: 409 });
    return {
      nodeId: node.id, eventKind: node.event.kind, eventId: node.event.id,
      tickets: node.ticketIds.map(id => {
        const ticket = reference.tickets.find(candidate => String(candidate.id) === id);
        if (!ticket) throw Object.assign(new Error('A selected ticket is no longer available.'), { status: 409 });
        return snapshotFunnelTicket(reference.event, ticket, node.event.kind, authority, {});
      }),
    };
  });
  return { version: 1, capturedAt: new Date().toISOString(), offers };
}
