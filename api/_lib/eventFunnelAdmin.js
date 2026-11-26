import { validateFunnelGraph, evaluateFunnelRoute, FunnelGraphError } from '../../shared/eventFunnelGraph.mjs';
import { funnelSimpleTickets } from '../../shared/eventFunnelCatalog.mjs';
import { isFutureFunnelEvent } from '../../shared/eventFunnelAuthoring.mjs';
import { buildFunnelPublicationSnapshot } from './eventFunnelPublication.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function check(result) {
  if (result.error) {
    if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(result.error.code)) fail('Funnel authoring schema is not installed.', 503);
    if (result.error.code === 'PT404') fail('This funnel is no longer available.', 404);
    if (result.error.code === 'PT409') fail('This definition changed. Reload it before saving.', 409);
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
  return { positions };
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
        return res.status(200).json({ tenantId: context.tenantId, definitions, readiness, membershipTiers });
      }
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 350000) fail('Invalid request.');
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
      const definition = check(await db.rpc('event_funnel_save_definition', {
        p_tenant: context.tenantId, p_id: body.id, p_actor: actor, p_expected_revision: body.expectedRevision,
        p_name: body.name.trim(), p_graph: body.graph, p_layout: layout,
      }));
      return res.status(200).json(definition);
    } catch (error) {
      return res.status(error instanceof FunnelGraphError ? 400 : error.status || 500)
        .json({ error: error instanceof FunnelGraphError || error.status ? error.message : 'Unable to manage event funnels.' });
    }
  };
}
