import { filterViewerTickets, projectSimpleTicketAudience } from '../../shared/ticketAudienceProjection.js';
export { filterViewerTickets, projectSimpleTicketAudience } from '../../shared/ticketAudienceProjection.js';
import { loadPrivateTicketViewer } from './privateTicketAccess.js';
import { hasAdminAccess } from './tenantContext.js';
import { getCallerGroupEventsAccess } from './memberGroupEventsAccess.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTicketAudienceEntity = name => ['event', 'complexevent', 'complexeventticketclass'].includes(name);

// Reject alternate projections before they can omit the policy needed to make
// a decision, or alias private JSON into an otherwise innocuous response.
export function ticketAudienceProjectionError(entity, query = {}) {
  if (query.expand && (isTicketAudienceEntity(entity)
    || /event|ticket|pricing_config|selected_member_ids|audience_mode/i.test(String(query.expand)))) {
    return 'Event ticket projections must use the event endpoint';
  }
  if (/selected_member_ids|audience_mode|pricing_config/i.test(JSON.stringify([query.filter, query.sort]))) {
    return 'Ticket audience policies cannot be searched through generic filters';
  }
  return null;
}

export async function loadTicketAudienceReadContext({ req, ctx, db }) {
  const tenantId = ctx.effectiveTenantId || ctx.tenantId;
  const admin = ctx.isAuthenticated && !!tenantId && await hasAdminAccess(ctx);
  const simpleGroups = new Set();
  const complexGroups = new Set();
  if (!admin && ctx.isAuthenticated && ctx.memberId) {
    const access = await getCallerGroupEventsAccess(req);
    if (!access.error && access.tenantContext?.tenantId === tenantId) {
      // The discovery helper returns groups with EITHER event type enabled.
      // Editable audience data requires the same per-type authority as writes.
      for (const group of access.groups || []) {
        if (group.simpleEnabled === true) simpleGroups.add(group.groupId);
        if (group.complexEnabled === true) complexGroups.add(group.groupId);
      }
    }
  }
  const managedComplexIds = new Set();
  if (complexGroups.size) {
    const { data, error } = await db.from('complex_event').select('id')
      .eq('tenant_id', tenantId).in('member_group_id', [...complexGroups]);
    if (error) throw new Error('Unable to verify event management access');
    for (const event of data || []) managedComplexIds.add(event.id);
  }
  return {
    tenantId, admin, simpleGroups, complexGroups, managedComplexIds,
    viewer: admin ? null : await loadPrivateTicketViewer(req, tenantId, db),
  };
}

// Apply BEFORE pagination/count. Filtering only the response leaks counts and
// returns empty pages even when later accessible tickets exist.
export function scopeTicketAudienceQuery(query, entity, context) {
  if (entity !== 'complexeventticketclass' || context.admin) return query;
  const clauses = ['audience_mode.is.null', 'audience_mode.eq.legacy'];
  if (context.viewer?.tenantId === context.tenantId && UUID.test(context.viewer?.memberId || '')) {
    clauses.push(`and(audience_mode.eq.selected_members,selected_member_ids.cs.{${context.viewer.memberId}})`);
  }
  const ids = [...context.managedComplexIds].filter(id => UUID.test(id));
  if (ids.length) clauses.push(`complex_event_id.in.(${ids.join(',')})`);
  return query.or(clauses.join(','));
}

export function projectTicketAudienceRows(rows, entity, context) {
  if (context.admin) return rows;
  return (rows || []).flatMap(row => {
    if (row.tenant_id !== context.tenantId) return [];
    const manager = entity === 'complexeventticketclass'
      ? context.managedComplexIds.has(row.complex_event_id)
      : (entity === 'event' ? context.simpleGroups : context.complexGroups).has(row.member_group_id);
    if (manager) return [row];
    if (entity === 'complexeventticketclass') {
      return filterViewerTickets([row], context.viewer, context.tenantId);
    }
    return [projectSimpleTicketAudience(row, context.viewer, context.tenantId)];
  });
}
