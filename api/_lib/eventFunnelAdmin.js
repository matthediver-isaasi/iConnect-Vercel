import { validateFunnelGraph, evaluateFunnelRoute, FunnelGraphError } from '../../shared/eventFunnelGraph.mjs';
import { funnelSimpleTickets } from '../../shared/eventFunnelCatalog.mjs';
import { isFutureFunnelEvent } from '../../shared/eventFunnelAuthoring.mjs';
import { buildFunnelPublicationSnapshot } from './eventFunnelPublication.js';
import { funnelConnectorKeys, isFunnelLayoutPoint, isFunnelStepWidth } from '../../shared/eventFunnelEditorLayout.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function check(result) {
  if (result.error) {
    if (MISSING_SCHEMA.includes(result.error.code)) fail('Funnel authoring schema is not installed.', 503);
    if (result.error.code === 'PT404') fail('This funnel is no longer available.', 404);
    if (result.error.code === 'PT409') fail(result.error.message?.startsWith('Another published funnel already routes ticket ')
      ? result.error.message : result.error.message === 'A funnel group with this name already exists.' ? result.error.message
        : 'This definition or event setting changed. Reload it before saving.', 409);
    if (['22023', '22P02'].includes(result.error.code)) fail('An event or ticket reference is no longer valid.', 400);
    fail('Funnel data could not be loaded or saved.', 503);
  }
  return result.data;
}
export function validateFunnelLayout(layout, graph) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)
    || !layout.positions || typeof layout.positions !== 'object' || Array.isArray(layout.positions)
    || JSON.stringify(layout).length > 65536) fail('Invalid editor layout.');
  const ids = new Set(graph.nodes.map(node => node.id));
  const positions = {};
  for (const [id, position] of Object.entries(layout.positions)) {
    if (!ids.has(id) || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
      || Math.abs(position.x) > 100000 || Math.abs(position.y) > 100000) fail('Invalid node position.');
    Object.defineProperty(positions, id, { value: { x: position.x, y: position.y }, enumerable: true });
  }
  const result = { positions };
  if (layout.nodeWidths !== undefined) {
    if (!layout.nodeWidths || typeof layout.nodeWidths !== 'object' || Array.isArray(layout.nodeWidths)) fail('Invalid step widths.');
    for (const [id, width] of Object.entries(layout.nodeWidths)) {
      if (!ids.has(id) || !isFunnelStepWidth(width)) fail('Invalid step width.');
    }
    result.nodeWidths = Object.fromEntries(Object.entries(layout.nodeWidths));
  }
  if (layout.connectors === undefined) return result;
  if (!layout.connectors || typeof layout.connectors !== 'object' || Array.isArray(layout.connectors)) fail('Invalid connector layout.');
  const keys = funnelConnectorKeys(graph);
  const connectors = {};
  for (const [key, value] of Object.entries(layout.connectors)) {
    if (!keys.has(key) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => !['bends', 'labelOffset'].includes(field))) fail('Invalid connector reference.');
    if (value.bends !== undefined && (!Array.isArray(value.bends) || value.bends.length > 24
      || !value.bends.every(isFunnelLayoutPoint))) fail('Invalid connector bends.');
    if (value.labelOffset !== undefined && !isFunnelLayoutPoint(value.labelOffset)) fail('Invalid connector label position.');
    Object.defineProperty(connectors, key, { enumerable: true, value: {
      ...(value.bends !== undefined ? { bends: value.bends.map(({ x, y }) => ({ x, y })) } : {}),
      ...(value.labelOffset !== undefined ? { labelOffset: { x: value.labelOffset.x, y: value.labelOffset.y } } : {}),
    } });
  }
  return { ...result, connectors };
}
export async function validateFunnelReferences(db, tenantId, graph) {
  validateFunnelGraph(graph);
  if (graph.tenantId !== tenantId) fail('Invalid tenant scope.', 403);
  const references = new Map();
  const selections = graph.nodes.flatMap(node => [
    ...(node.event ? [node] : []),
    ...(node.rules || []).flatMap(rule => (rule.tests || []).map(test => ({
      event: test.event, ticketIds: test.ticketId ? [test.ticketId] : [],
    }))),
  ]);
  for (const node of selections) {
    if (!UUID.test(node.event.id)) fail('Invalid event reference.');
    const reference = `${node.event.kind}:${node.event.id}`;
    if (!references.has(reference)) {
      const event = check(await db.from(node.event.kind === 'simple' ? 'event' : 'complex_event')
        .select('*').eq('tenant_id', tenantId).eq('id', node.event.id).maybeSingle());
      if (!event) fail('An event is no longer available.', 404);
      if (!isFutureFunnelEvent(event)) fail('Choose a future event that has not been completed or cancelled.');
      const tickets = node.event.kind === 'simple' ? funnelSimpleTickets(event)
        : check(await db.from('complex_event_ticket_class').select('*')
          .eq('tenant_id', tenantId).eq('complex_event_id', node.event.id));
      references.set(reference, { event, tickets });
    }
    const { tickets } = references.get(reference);
    if (node.ticketIds.some(id => !tickets.some(ticket => String(ticket.id) === id))) fail('A selected ticket is no longer available.');
  }
  await validateMembershipReferences(db, tenantId, graph);
  return references;
}
export const membershipTierScope = tier => tier?.structure_scope_type === 'member' ? 'member' : 'organization';
export async function listFunnelMembershipTiers(db, tenantId) {
  const rows = check(await db.from('membership_tier_config').select('id,name,structure_scope_type,is_active')
    .eq('tenant_id', tenantId).order('name', { ascending: true }).limit(500));
  return (rows || []).map(tier => ({ id: tier.id, name: tier.name || 'Untitled membership tier',
    scope: membershipTierScope(tier), active: tier.is_active !== false }));
}
// Saved stages that refer to an unavailable tier are rejected, never pruned:
// the administrator must replace the tier before saving or previewing.
export async function validateMembershipReferences(db, tenantId, graph) {
  const stages = graph.nodes.filter(node => node.type === 'membership');
  if (!stages.length) return;
  const ids = [...new Set(stages.map(node => node.membership.scheduleId))];
  const rows = check(await db.from('membership_tier_config').select('id,name,structure_scope_type,is_active')
    .eq('tenant_id', tenantId).in('id', ids));
  for (const node of stages) {
    const tier = (rows || []).find(row => row.id === node.membership.scheduleId);
    if (!tier || tier.is_active === false) fail('A membership stage refers to a membership tier that is no longer available. Choose another tier.');
    if (membershipTierScope(tier) !== node.membership.scope) fail('A membership stage no longer matches its tier type. Choose the tier again.');
  }
}
const MISSING_SCHEMA = ['42P01', '42883', 'PGRST202', 'PGRST205'];
// Funnel Groups and event links are an additive release. Until installed the
// existing funnel authoring keeps working and the UI reports them unavailable.
export async function loadFunnelCollections(db, tenantId) {
  const [groups, members, links] = await Promise.all([
    db.from('event_funnel_collection').select('id,name,revision').eq('tenant_id', tenantId).order('name', { ascending: true }).limit(501),
    db.from('event_funnel_collection_member').select('definition_id,collection_id').eq('tenant_id', tenantId).limit(1001),
    db.from('event_funnel_event_link').select('event_kind,event_id,definition_id,collection_id,revision')
      .eq('tenant_id', tenantId).limit(5001),
  ]);
  if ([groups, members, links].some(result => MISSING_SCHEMA.includes(result.error?.code))) {
    return { groupsAvailable: false, groups: [], groupMembers: [], eventLinks: [] };
  }
  const [g, m, l] = [groups, members, links].map(check);
  if (g.length > 500 || m.length > 1000 || l.length > 5000) fail('Too many funnel groups or event links to load safely.', 409);
  return { groupsAvailable: true, groups: g, groupMembers: m, eventLinks: l };
}
const optionalUuid = value => value === null || value === undefined ? null : UUID.test(value) ? value : fail('Invalid reference.');
export async function manageFunnelCollections(db, tenantId, actor, body) {
  const revision = body.expectedRevision;
  const validRevision = Number.isSafeInteger(revision) && revision >= 0;
  if (body.action === 'save_group') {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!UUID.test(body.id || '') || !validRevision || !name || name.length > 120) fail('Enter a group name of up to 120 characters.');
    return check(await db.rpc('event_funnel_collection_save', {
      p_tenant: tenantId, p_id: body.id, p_name: name, p_revision: revision, p_actor: actor,
    }));
  }
  if (body.action === 'delete_group') {
    if (!UUID.test(body.id || '') || !validRevision || revision < 1) fail('Invalid funnel group.');
    return check(await db.rpc('event_funnel_collection_delete', {
      p_tenant: tenantId, p_id: body.id, p_revision: revision, p_actor: actor,
    }));
  }
  if (body.action === 'assign_group') {
    if (!UUID.test(body.definitionId || '')) fail('Invalid funnel.');
    return check(await db.rpc('event_funnel_collection_assign', {
      p_tenant: tenantId, p_definition: body.definitionId, p_collection: optionalUuid(body.groupId), p_actor: actor,
    }));
  }
  const definitionId = optionalUuid(body.definitionId), groupId = optionalUuid(body.groupId);
  if (!UUID.test(body.eventId || '') || !['simple', 'complex'].includes(body.eventKind) || !validRevision
    || (definitionId && groupId)) fail('Choose either one funnel or one funnel group.');
  return check(await db.rpc('event_funnel_set_event_link', {
    p_tenant: tenantId, p_kind: body.eventKind, p_event: body.eventId, p_definition: definitionId,
    p_collection: groupId, p_revision: revision, p_actor: actor,
  }));
}
export function createEventFunnelAdminHandler({ db, getContext, hasAdminAccess, hasFeatureAccess,
  loadPublicationSnapshot = buildFunnelPublicationSnapshot }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); fail('Method not allowed.', 405); }
      const context = await getContext(req);
      if (context?.tenantMismatch) fail('Tenant context changed. Refresh and try again.', 409);
      if (!context?.isAuthenticated || !context.tenantId) fail('Authentication required.', 401);
      if (!await hasAdminAccess(context) || (!context.tenantUserId
        && !await hasFeatureAccess(context.roleId, 'events.browse-events.create', context.memberExcludedFeatures || []))) {
        fail('Event management permission required.', 403);
      }
      const actor = context.tenantUserId ? `user:${context.tenantUserId}` : `member:${context.memberId}`;
      if (!context.tenantUserId && !context.memberId) fail('Verified administrator identity required.', 403);
      if (req.method === 'POST') {
        // JSON-only same-origin writes; reject cross-site browser submission.
        if (!/^application\/json(?:;|$)/i.test(req.headers?.['content-type'] || '')
          || req.headers?.['sec-fetch-site'] === 'cross-site') fail('Same-origin JSON request required.', 403);
        if (req.headers?.origin) {
          let host;
          try { host = new URL(req.headers.origin).host; } catch { fail('Invalid request origin.', 403); }
          if (host !== req.headers.host) fail('Same-origin request required.', 403);
        }
      }
      if (!check(await db.rpc('event_funnel_consume_limit', { p_tenant: context.tenantId, p_actor: actor }))) {
        res.setHeader('Retry-After', '60'); fail('Too many requests. Try again shortly.', 429);
      }
      if (req.method === 'GET') {
        const readiness = check(await db.rpc('event_funnel_readiness'));
        const definitions = check(await db.from('event_funnel_definition').select('id,name,revision,graph,layout,published_version_id')
          .eq('tenant_id', context.tenantId).order('updated_at', { ascending: false }).limit(101));
        if (definitions.length > 100) fail('This tenant has more than 100 funnel definitions; paginated authoring is required.', 409);
        const membershipTiers = await listFunnelMembershipTiers(db, context.tenantId);
        const eventSettings = check(await db.from('event_funnel_event_setting')
          .select('event_kind,event_id,enabled,revision').eq('tenant_id', context.tenantId).limit(1000));
        if (eventSettings.length >= 1000) fail('Too many event settings to load safely.', 409);
        const collections = await loadFunnelCollections(db, context.tenantId);
        return res.status(200).json({ tenantId: context.tenantId, definitions, readiness, membershipTiers, eventSettings, ...collections });
      }
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 350000) fail('Invalid request.');
      if (body.action === 'set_enabled') {
        if (!UUID.test(body.eventId || '') || !['simple', 'complex'].includes(body.eventKind)
          || typeof body.enabled !== 'boolean' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) fail('Invalid event setting.');
        const event = check(await db.from(body.eventKind === 'simple' ? 'event' : 'complex_event').select('*')
          .eq('tenant_id', context.tenantId).eq('id', body.eventId).maybeSingle());
        if (!event) fail('Event not found.', 404);
        if (body.enabled && (event.waiting_list_enabled === true || body.eventKind === 'simple' && (event.program_tag || event.is_complex === true))) {
          fail('Waiting lists and programme entitlements use their existing registration process.');
        }
        return res.status(200).json(check(await db.rpc('event_funnel_set_enabled', {
          p_tenant: context.tenantId, p_kind: body.eventKind, p_event: body.eventId, p_enabled: body.enabled,
          p_revision: body.expectedRevision, p_actor: actor,
        })));
      }
      if (['save_group', 'delete_group', 'assign_group', 'set_event_link'].includes(body.action)) {
        return res.status(200).json(await manageFunnelCollections(db, context.tenantId, actor, body));
      }
      if (body.action === 'publish') {
        if (!UUID.test(body.id || '') || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) {
          fail('Save the funnel before publishing.');
        }
        const readiness = check(await db.rpc('event_funnel_readiness'));
        if (readiness?.version !== 1 || readiness.activationVersion !== 1 || readiness.purchasing !== true) {
          fail('Publishing is unavailable until the application and recovery workers have been verified for live checkout.', 409);
        }
        // Never publish a client-supplied graph, actor, commercial snapshot,
        // price or tenant. Revalidate the saved revision before the atomic RPC.
        const definition = check(await db.from('event_funnel_definition').select('id,revision,graph')
          .eq('tenant_id', context.tenantId).eq('id', body.id).maybeSingle());
        if (!definition) fail('This funnel is no longer available.', 404);
        if (definition.revision !== body.expectedRevision) fail('This definition changed. Reload it before publishing.', 409);
        const references = await validateFunnelReferences(db, context.tenantId, definition.graph);
        const commercial = await loadPublicationSnapshot({
          db, tenantId: context.tenantId, graph: definition.graph, references,
        });
        const published = check(await db.rpc('event_funnel_publish', {
          p_tenant: context.tenantId, p_definition: body.id, p_expected_revision: body.expectedRevision,
          p_actor: actor, p_commercial: commercial,
        }));
        if (published?.published !== true || !UUID.test(published.versionId || '')
          || published.revision !== body.expectedRevision) fail('Publication could not be confirmed. Reload before retrying.', 503);
        return res.status(200).json({ ...published, published_version_id: published.versionId });
      }
      if (!['save', 'preview'].includes(body.action)) fail('Unknown action.');
      await validateFunnelReferences(db, context.tenantId, body.graph);
      if (body.action === 'preview') {
        return res.status(200).json(evaluateFunnelRoute(body.graph, {
          selections: body.selections, decisions: body.decisions, checkoutNow: body.checkoutNow,
        }));
      }
      if (!UUID.test(body.id || '') || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0
        || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) fail('Invalid definition details.');
      const layout = validateFunnelLayout(body.layout, body.graph);
      // Load the HTML parser only for authored modal content, not ordinary
      // readiness, catalogue, preview or existing funnel requests.
      const graph = body.graph.nodes.some(node => node.presentation)
        ? (await import('./eventFunnelPresentation.js')).sanitizeFunnelPresentation(body.graph)
        : body.graph;
      const definition = check(await db.rpc('event_funnel_save_definition', {
        p_tenant: context.tenantId, p_id: body.id, p_actor: actor, p_expected_revision: body.expectedRevision,
        p_name: body.name.trim(), p_graph: graph, p_layout: layout,
      }));
      return res.status(200).json(definition);
    } catch (error) {
      return res.status(error instanceof FunnelGraphError ? 400 : error.status || 500)
        .json({ error: error instanceof FunnelGraphError || error.status ? error.message : 'Unable to manage event funnels.' });
    }
  };
}
