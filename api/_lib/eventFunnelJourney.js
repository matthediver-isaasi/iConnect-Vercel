import { FunnelJourneyError, planFunnelJourneyChange, readFunnelJourney } from '../../shared/eventFunnelJourney.mjs';

function checked({ data, error }) {
  if (error) {
    const [message, code, status] = ({
      PT404: ['This reservation is not available.', 'JOURNEY_NOT_FOUND', 404],
      PT409: ['Your reservation changed or expired. Reload before continuing.', 'REVISION_CONFLICT', 409],
      '23514': ['Some selected tickets are no longer available. Your previous reservation has been kept.', 'CAPACITY_UNAVAILABLE', 409],
      '22023': ['A selected ticket is no longer available.', 'INVALID_SELECTION', 400],
    })[error.code] || ['The reservation could not be saved. Your previous selection has not been discarded.', 'JOURNEY_UNAVAILABLE', 503];
    throw new FunnelJourneyError(message, code, status);
  }
  if (data == null) throw new FunnelJourneyError('Reservation data is unavailable.', 'JOURNEY_UNAVAILABLE', 503);
  return data;
}
function scope(owner) {
  if (!owner?.tenantId || !owner.sessionId || (!!owner.memberId === !!owner.capabilityHash)) {
    throw new FunnelJourneyError('Verified reservation ownership is required.', 'JOURNEY_NOT_FOUND', 404);
  }
  return {
    p_tenant: owner.tenantId, p_id: owner.sessionId,
    p_member: owner.memberId || null, p_capability_hash: owner.capabilityHash || null,
  };
}

/**
 * Internal service: callers derive owner from a verified member session or an
 * opaque capability, never from command fields. The commercial resolver must
 * validate eligibility, attendee answers and compatibility and return authoritative
 * new-line prices. No default resolver or early booking fallback is allowed.
 */
// Display-only offer text for complimentary membership stages. Unavailable
// tiers stay visible as unavailable; checkout re-verifies eligibility.
export async function membershipOffers(db, tenantId, graph) {
  const stages = (graph?.nodes || []).filter(node => node.type === 'membership');
  if (!stages.length) return {};
  const { data, error } = await db.from('membership_tier_config').select('id,name,structure_scope_type,is_active')
    .eq('tenant_id', tenantId).in('id', [...new Set(stages.map(node => node.membership.scheduleId))]);
  if (error) throw new FunnelJourneyError('Membership offers could not be loaded.', 'JOURNEY_UNAVAILABLE', 503);
  return Object.fromEntries(stages.map(node => {
    const tier = (data || []).find(row => row.id === node.membership.scheduleId);
    const available = !!tier && tier.is_active !== false
      && (tier.structure_scope_type === 'member' ? 'member' : 'organization') === node.membership.scope;
    return [node.id, { name: available ? tier.name : null, available, scope: node.membership.scope,
      recipientMode: node.membership.recipientMode, description: node.membership.description || '' }];
  }));
}

export function createEventFunnelJourneyService({ db, resolveSelection, validateLines }) {
  async function read(owner) {
    const snapshot = checked(await db.rpc('event_funnel_read_session', scope(owner)));
    if (snapshot.session.tenant_id !== owner.tenantId || snapshot.session.id !== owner.sessionId
      || snapshot.graph.tenantId !== owner.tenantId) {
      throw new FunnelJourneyError('Reservation ownership could not be verified.', 'JOURNEY_UNAVAILABLE', 503);
    }
    return snapshot;
  }
  return {
    async read(owner) {
      const snapshot = await read(owner);
      return { ...snapshot, route: readFunnelJourney(snapshot).route,
        membershipOffers: await membershipOffers(db, owner.tenantId, snapshot.graph) };
    },
    async change(owner, command) {
      const snapshot = await read(owner);
      const plan = planFunnelJourneyChange(snapshot, command);
      const oldHolds = new Map(snapshot.holds.map(hold => [JSON.stringify([hold.node_id, hold.ticket_id]), hold]));
      const nodes = new Map(snapshot.graph.nodes.map(node => [node.id, node]));
      const lines = [], answerUpdates = Object.create(null);
      for (const selection of plan.selections) {
        const node = nodes.get(selection.nodeId);
        const oldForNode = snapshot.holds.filter(hold => hold.node_id === node.id);
        const changed = plan.rereserve || command.type === 'select' && command.nodeId === node.id
          || selection.tickets.some(ticket => !oldHolds.has(JSON.stringify([node.id, ticket.id])));
        let resolved = null;
        if (changed) {
          if (typeof resolveSelection !== 'function') {
            throw new FunnelJourneyError('Ticket eligibility and pricing are not ready.', 'COMMERCIAL_ADAPTER_UNAVAILABLE', 503);
          }
          const resolution = await resolveSelection({
            owner, node, tickets: selection.tickets,
            answers: plan.answerNode === node.id ? plan.answers : snapshot.drafts[node.id] || {},
            previousHolds: plan.rereserve ? [] : oldForNode,
            snapshot, selections: plan.selections, rereserve: plan.rereserve,
          });
          resolved = Array.isArray(resolution) ? resolution : resolution?.lines;
          if (!Array.isArray(resolution) && resolution?.answers) {
            answerUpdates[node.id] = resolution.answers;
          }
          if (!Array.isArray(resolved) || resolved.length !== selection.tickets.length
            || new Set(resolved.map(line => line?.ticketId)).size !== resolved.length
            || resolved.some(line => !line || !selection.tickets.some(ticket => ticket.id === line.ticketId))) {
            throw new FunnelJourneyError('Ticket prices could not be verified.', 'JOURNEY_UNAVAILABLE', 503);
          }
        }
        for (const ticket of selection.tickets) {
          const previous = oldHolds.get(JSON.stringify([node.id, ticket.id]));
          // Reusing a live line reuses its immutable per-unit economics; never
          // reinterpret it against an administrator's intervening price edit.
          const price = previous && !plan.rereserve ? previous.price_snapshot
            : resolved?.find(line => line.ticketId === ticket.id)?.priceSnapshot;
          if (!price || typeof price !== 'object' || Array.isArray(price)) {
            throw new FunnelJourneyError('Ticket prices could not be verified.', 'JOURNEY_UNAVAILABLE', 503);
          }
          lines.push({ nodeId: node.id, ticketId: ticket.id, quantity: ticket.quantity, priceSnapshot: price });
        }
      }
      if (validateLines) await validateLines(lines);
      const committed = checked(await db.rpc('event_funnel_apply_journey', {
        ...scope(owner), p_expected_revision: plan.expectedRevision, p_lines: lines,
        p_journey: plan.journey, p_answer_node: plan.answerNode,
        p_answers: plan.answerNode && answerUpdates[plan.answerNode] || plan.answers,
        p_answer_updates: answerUpdates, p_rereserve: plan.rereserve,
      }));
      return { ...committed, route: readFunnelJourney(committed).route, removed: plan.removed,
        membershipOffers: await membershipOffers(db, owner.tenantId, committed.graph) };
    },
  };
}
