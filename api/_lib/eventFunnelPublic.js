import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
import { createEventFunnelJourneyService } from './eventFunnelJourney.js';
import {
  createFunnelGuestCapability, publicFunnelSnapshot, requireSameOriginJson, requireFunnelOwner, requireFunnelTenant,
  readCapability,
} from './eventFunnelJourneyHandler.js';
import { filterViewerTickets } from '../../shared/ticketAudienceProjection.js';
import { publicTicketMemberPolicy } from '../../shared/publicTicketMemberPolicy.js';
import { loadComplexReleaseTickets } from './ticketReleaseAccess.js';
import { funnelSimpleTickets } from '../../shared/eventFunnelCatalog.mjs';
import { loadTicketOrganizationTypes } from './ticketOrganizationType.js';
import { isTicketAccessibleToMember } from './ticketAccess.js';
import { isTicketVisibleToUser } from './complexEventPricing.js';
import { isPrivateTicket } from '../../shared/ticketAudience.js';
import { suppressImmediateSchedule } from '../../shared/eventTiming.js';
import { createFunnelSelectionResolver } from './eventFunnelCommercial.js';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (message, code, status = 400) => { throw new FunnelJourneyError(message, code, status); };
const check = result => {
  if (result.error) {
    if (result.error.code === 'PT404') fail('This reservation is not available.', 'JOURNEY_NOT_FOUND', 404);
    if (result.error.code === 'PT409') fail('The reservation or event changed. Reload before continuing.', 'REVISION_CONFLICT', 409);
    fail('Event registration is temporarily unavailable.', 'JOURNEY_UNAVAILABLE', 503);
  }
  if (result.data == null) fail('Event registration is temporarily unavailable.', 'JOURNEY_UNAVAILABLE', 503);
  return result.data;
};
const pick = (value, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
const EVENT_FIELDS = `id tenant_id title description summary slug start_date end_date location image_url image_focal_point
 status timezone event_state event_type is_online available_seats capacity_mode total_capacity is_unlimited_registration
 show_seat_count show_ticket_availability registration_closes_at is_training speaker_ids speaker_display_mode sponsor_display_mode
 member_group_id group_event_public cta_override_url cta_override_mode cta_button_label replace_booking_elements
 booking_replacement_message booking_replacement_cta_label booking_replacement_title attached_documents documents_section_title
 custom_duration_explainer dietary_options allergy_options accessibility_options allow_public_invoice_po program_tag waiting_list_enabled`.split(/\s+/);
const TICKET_FIELDS = `id name description price currency is_free visibility_mode audience_mode private_ticket_eligible
 organization_type_enabled organization_type_eligible role_ids role_match_only member_group_ids is_public
 is_group_ticket group_size group_cutoff_date early_bird_enabled early_bird_price early_bird_deadline
 release_at release_timezone close_at close_timezone offer_type bogo_logic_type bogo_buy_quantity bogo_get_free_quantity
 bulk_discount_threshold bulk_discount_percentage is_default available_count is_unlimited_tickets
 linked_track_ids all_tracks display_order`.split(/\s+/);

export async function findFunnelEntry(db, tenantId, kind, eventId, ticketId = null) {
  const entry = check(await db.rpc('event_funnel_resolve_entry', {
    p_tenant: tenantId, p_event_kind: kind, p_event_id: eventId, p_ticket: ticketId,
  }));
  if (entry.active === false && entry.outcome === 'normal' && ['disabled', 'no_match'].includes(entry.reason)) return entry;
  if (entry.active === true && entry.routing === 'ticket' && ticketId === null && !entry.versionId) return entry;
  if (entry.active !== true || !uuid(entry.versionId) || typeof entry.sourceNodeId !== 'string') {
    fail('The event registration route could not be verified.', 'JOURNEY_UNAVAILABLE', 503);
  }
  return entry;
}

export async function loadFunnelOffer(db, owner, snapshot, nodeId) {
  const node = snapshot.graph.nodes.find(candidate => candidate.id === nodeId);
  if (!node?.event || !snapshot.route.route.includes(nodeId)
    || !node.requires.every(id => snapshot.route.retainedNodeIds.includes(id))) {
    fail('This offer is not on your current registration route.', 'OFFER_UNAVAILABLE', 403);
  }
  const event = check(await db.from(node.event.kind === 'simple' ? 'event' : 'complex_event').select('*')
    .eq('tenant_id', owner.tenantId).eq('id', node.event.id).maybeSingle());
  const catalog = node.event.kind === 'simple' ? funnelSimpleTickets(event) : await loadComplexReleaseTickets(db, event);
  const member = owner.memberId ? check(await db.from('member').select('id,role_id').eq('tenant_id', owner.tenantId)
    .eq('id', owner.memberId).maybeSingle()) : null;
  const viewer = member ? { memberId: member.id, tenantId: owner.tenantId, roleId: member.role_id,
    organizationTypes: await loadTicketOrganizationTypes(db, owner.tenantId, member.id) } : null;
  const groups = member ? check(await db.from('member_group_assignment').select('group_id')
    .eq('tenant_id', owner.tenantId).eq('member_id', member.id)).map(row => row.group_id) : [];
  const capacity = check(await db.rpc('event_funnel_offer_capacity', {
    p_tenant: owner.tenantId, p_id: owner.sessionId, p_member: owner.memberId || null,
    p_capability_hash: owner.capabilityHash || null, p_node: nodeId,
  }));
  if (capacity.revision !== snapshot.session.revision || !Array.isArray(capacity.tickets)) {
    fail('Your reservation changed. Reload this event.', 'REVISION_CONFLICT', 409);
  }
  const saved = snapshot.holds.filter(hold => hold.node_id === nodeId);
  const sourceSwitch = node.type === 'source' && snapshot.session.source_ticket_id;
  const tickets = filterViewerTickets(catalog.filter(ticket => sourceSwitch || node.ticketIds.includes(String(ticket.id))), viewer, owner.tenantId)
    .filter(ticket => (isPrivateTicket(ticket) || isTicketVisibleToUser(ticket, !!member))
      && isTicketAccessibleToMember({ ticketClass: ticket, memberRoleId: member?.role_id, memberGroupIds: groups,
        memberId: member?.id, tenantId: owner.tenantId, ticketTenantId: owner.tenantId, organizationTypeViewer: viewer }))
    .map(ticket => {
      const remaining = capacity.tickets.find(row => row.ticketId === String(ticket.id));
      if (!remaining && !sourceSwitch) fail('Ticket availability could not be verified.', 'JOURNEY_UNAVAILABLE', 503);
      // Other initial classes are choices for a new authoritative route. Stock
      // is checked transactionally by the switch, never borrowed from this node.
      const left = remaining?.remaining ?? (sourceSwitch && !remaining ? null : remaining?.remaining);
      const frozen = saved.find(hold => hold.ticket_id === String(ticket.id))?.price_snapshot;
      return {
        ...pick(ticket, TICKET_FIELDS), ...publicTicketMemberPolicy(ticket),
        true_available: left, remaining: left,
        is_sold_out: left !== null && left <= 0,
        ...(frozen?.version === 1 ? {
          price: frozen.unitAmount ?? frozen.unitMinor / 100, is_free: frozen.unitMinor === 0,
          currency: frozen.currency, early_bird_enabled: false,
          is_group_ticket: frozen.groupSize > 1, group_size: frozen.groupSize,
          ...(frozen.rules ? {
            offer_type: frozen.rules.offerType, bogo_buy_quantity: frozen.rules.bogoBuy,
            bogo_get_free_quantity: frozen.rules.bogoFree, bogo_logic_type: frozen.rules.bogoLogic,
            bulk_discount_threshold: frozen.rules.bulkThreshold, bulk_discount_percentage: frozen.rules.bulkPercentage,
          } : {}),
        } : {}),
      };
    });
  const publicEvent = {
    ...pick(event, EVENT_FIELDS), is_complex: node.event.kind === 'complex',
    available_seats: capacity.eventRemaining,
    is_unlimited_registration: capacity.eventRemaining === null,
    pricing_config: { ticket_classes: tickets, ticket_classes_configured: true },
  };
  return { nodeId, eventId: event.id, eventKind: node.event.kind, selectionMode: node.selectionMode || 'multiple',
    sourceSwitch: Boolean(sourceSwitch),
    event: node.event.kind === 'simple' ? suppressImmediateSchedule(publicEvent) : publicEvent,
    tickets, draft: { answers: snapshot.drafts[nodeId] || {} },
    selectedTickets: saved.map(hold => ({ id: hold.ticket_id, quantity: hold.quantity })) };
}

export function createFunnelPublicHandler(action, { db, resolveTenant, loadViewer, loadOffer = loadFunnelOffer,
  resolveSelection = createFunnelSelectionResolver({ db }) }) {
  const service = createEventFunnelJourneyService({ db, resolveSelection });
  return async (req, res) => {
    for (const [key, value] of Object.entries({
      'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive', Vary: 'Cookie',
    })) res.setHeader(key, value);
    try {
      const method = action === 'entry' ? 'GET' : 'POST';
      if (req.method !== method) { res.setHeader('Allow', method); fail('Method not allowed.', 'METHOD_NOT_ALLOWED', 405); }
      if (method === 'POST') requireSameOriginJson(req);
      const input = method === 'GET' ? req.query : req.body;
      const allowed = action === 'offer' ? ['sessionId', 'nodeId'] : action === 'entry'
        ? ['eventId', 'eventKind'] : ['eventId', 'eventKind', 'requestId', 'tickets', 'answers', 'previousSessionId', 'expectedRevision'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 75000
        || Object.keys(input).some(key => !allowed.includes(key))) fail('Invalid registration request.', 'INVALID_REQUEST');
      if (action === 'offer') {
        if (!uuid(input.sessionId) || typeof input.nodeId !== 'string') fail('Invalid offer.', 'INVALID_REQUEST');
        const owner = await requireFunnelOwner({ req, res, db, resolveTenant, loadViewer, sessionId: input.sessionId });
        return res.status(200).json(await loadOffer(db, owner, await service.read(owner), input.nodeId));
      }
      if (!uuid(input.eventId) || !['simple', 'complex'].includes(input.eventKind)) fail('Invalid event.', 'INVALID_REQUEST');
      const tenant = await resolveTenant(req);
      if (!uuid(tenant?.id)) fail('Event not found.', 'EVENT_NOT_FOUND', 404);
      if (action === 'entry') return res.status(200).json(await findFunnelEntry(db, tenant.id, input.eventKind, input.eventId));
      if (!uuid(input.requestId) || !Array.isArray(input.tickets) || !input.tickets.length
        || input.tickets.length > 100 || input.tickets.some(ticket => !ticket || typeof ticket.id !== 'string'
          || !/^[a-zA-Z0-9_-]{1,100}$/.test(ticket.id) || !Number.isSafeInteger(ticket.quantity)
          || ticket.quantity < 1 || ticket.quantity > 10000)
        || new Set(input.tickets.map(ticket => ticket.id)).size !== input.tickets.length) fail('Choose valid tickets.', 'INVALID_SELECTION');
      await requireFunnelTenant({ req, res, db, resolveTenant: async () => tenant });
      if (input.previousSessionId && !uuid(input.previousSessionId)) fail('Invalid source change.', 'INVALID_SELECTION');
      const previousOwner = input.previousSessionId
        ? await requireFunnelOwner({ req, res, db, resolveTenant, loadViewer, sessionId: input.previousSessionId }) : null;
      const existingHash = readCapability(req, input.requestId);
      // An owned guest journey stays a guest journey even if this browser has
      // since signed in. Never silently replace its original purchaser.
      const viewer = previousOwner?.capabilityHash || existingHash ? null : await loadViewer(req, tenant.id, db);
      if (viewer && (viewer.tenantId !== tenant.id || !uuid(viewer.memberId))) fail('Purchaser identity could not be verified.', 'JOURNEY_UNAVAILABLE', 403);
      const sessionId = input.requestId;
      const capability = viewer || existingHash ? null : createFunnelGuestCapability(sessionId);
      const owner = { tenantId: tenant.id, sessionId, memberId: viewer?.memberId || null, capabilityHash: existingHash || capability?.hash || null };
      if (capability) res.setHeader('Set-Cookie', capability.cookie);
      let entry;
      const ticket = input.tickets.length === 1 ? input.tickets[0].id : null;
      if (input.previousSessionId) {
        if (!uuid(input.previousSessionId) || !Number.isSafeInteger(input.expectedRevision) || !ticket) fail('Invalid source change.', 'INVALID_SELECTION');
        const replay = check(await db.rpc('event_funnel_replay_source_switch', {
          p_tenant: tenant.id, p_id: sessionId, p_old: input.previousSessionId, p_member: owner.memberId,
          p_capability: owner.capabilityHash, p_kind: input.eventKind, p_event: input.eventId, p_ticket: ticket,
        }));
        if (replay.found === true) {
          if (replay.outcome?.outcome === 'normal') return res.status(200).json(replay.outcome);
          return res.status(200).json({ ...publicFunnelSnapshot(await service.read(owner)), outcome: 'funnel' });
        }
        if (replay.found !== false) fail('Registration route could not be verified.', 'JOURNEY_UNAVAILABLE', 503);
        const previous = await service.read(previousOwner);
        const oldSource = previous.graph.nodes.find(node => node.id === previous.graph.entry);
        if (!previous.session.source_ticket_id || oldSource.event.kind !== input.eventKind || oldSource.event.id !== input.eventId) {
          fail('This source cannot be restarted.', 'INVALID_SELECTION', 409);
        }
        const purchaser = previous.holds.find(hold => hold.node_id === previous.graph.entry)?.price_snapshot?.purchaser;
        const purchaserFields = value => JSON.stringify(['first_name', 'last_name', 'email', 'organization']
          .map(field => String(value?.[field] || '').trim()));
        if (purchaser && !viewer && purchaserFields(input.answers?.purchaser) !== purchaserFields(purchaser)) {
          fail('Keep the original purchaser when changing the initial ticket.', 'INVALID_SELECTION', 409);
        }
        const candidate = await findFunnelEntry(db, tenant.id, input.eventKind, input.eventId, ticket);
        const version = candidate.active ? check(await db.from('event_funnel_version').select('graph')
          .eq('tenant_id', tenant.id).eq('id', candidate.versionId).maybeSingle()).graph : {
            ...previous.graph, entry: 'source', nodes: [{ ...oldSource, id: 'source', ticketIds: [ticket], accept: 'checkout' }, { id: 'checkout', type: 'checkout' }],
          };
        const source = version.nodes.find(node => node.id === version.entry);
        const resolved = await resolveSelection({ owner, node: source, tickets: input.tickets,
          answers: input.answers, previousHolds: [], selections: [{ nodeId: source.id, tickets: input.tickets }],
          snapshot: { graph: version, holds: [], drafts: { [source.id]: { purchaser } } }, rereserve: false });
        entry = check(await db.rpc('event_funnel_switch_source', {
          p_tenant: tenant.id, p_old: previousOwner.sessionId, p_member: owner.memberId,
          p_old_capability: previousOwner.capabilityHash || null, p_revision: input.expectedRevision,
          p_id: sessionId, p_capability: owner.capabilityHash, p_kind: input.eventKind, p_event: input.eventId,
          p_ticket: ticket, p_version: candidate.versionId || null,
          p_lines: resolved.lines.map(line => ({ nodeId: source.id, ticketId: line.ticketId,
            quantity: input.tickets.find(t => t.id === line.ticketId).quantity, priceSnapshot: line.priceSnapshot })),
          p_answers: resolved.answers,
        }));
      } else {
        entry = check(await db.rpc('event_funnel_start_routed', {
          p_tenant: tenant.id, p_id: sessionId, p_kind: input.eventKind, p_event: input.eventId,
          p_ticket: ticket, p_member: owner.memberId, p_capability_hash: owner.capabilityHash,
        }));
      }
      if (entry.active === false && entry.outcome === 'normal') return res.status(200).json(entry);
      if (entry.active !== true || !uuid(entry.versionId) || !entry.sourceNodeId) fail('Registration route could not be verified.', 'JOURNEY_UNAVAILABLE', 503);
      let snapshot = await service.read(owner);
      if (!input.previousSessionId && snapshot.holds.length === 0) {
        snapshot = await service.change(owner, { type: 'select', nodeId: entry.sourceNodeId,
          expectedRevision: snapshot.session.revision, tickets: input.tickets, answers: input.answers });
      } else if (!input.previousSessionId) {
        const saved = snapshot.holds.filter(hold => hold.node_id === entry.sourceNodeId);
        if (saved.length !== input.tickets.length || input.tickets.some(ticket =>
          !saved.some(hold => hold.ticket_id === ticket.id && hold.quantity === ticket.quantity))) {
          fail('This request already reserved a different selection. Open the saved reservation.', 'REVISION_CONFLICT', 409);
        }
      }
      return res.status(201).json({ ...publicFunnelSnapshot(snapshot), outcome: 'funnel' });
    } catch (error) {
      const known = error instanceof FunnelJourneyError;
      return res.status(known ? error.status : 503).json({
        error: known ? error.message : 'Event registration is temporarily unavailable.',
        code: known ? error.code : 'JOURNEY_UNAVAILABLE',
      });
    }
  };
}
