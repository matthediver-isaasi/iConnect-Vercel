import {
  fetchCategoriesWithAccess,
  computeHiddenSubcategories,
  isResourceHiddenByCategories,
} from './resourceCategoryAccess.js';
import { isResourceReleased } from '../../shared/resourceRelease.js';

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

// Restrict every booking read to this resource's events and this tenant/member.
// Separate email/owner queries avoid interpolating an email into PostgREST filters.
export async function canAccessResourceEvents(db, resource, ctx) {
  const links = resource.linked_events;
  if (!Array.isArray(links) || links.length === 0) return true;
  if (!ctx.memberId) return false;
  const eventIds = [...new Set(links.map(l => l?.event_id).filter(Boolean))];
  if (!eventIds.length) return false;
  const members = await rows(db.from('member').select('id, email')
    .eq('tenant_id', ctx.tenantId).eq('id', ctx.memberId));
  const member = members[0];
  if (!member) return false;
  const bookings = async (table, columns) => {
    const query = () => db.from(table).select(columns).eq('tenant_id', ctx.tenantId)
      .eq('status', 'confirmed').in('event_id', eventIds);
    const owned = await rows(query().eq('member_id', member.id));
    // Escape LIKE wildcards; email matching is case-insensitive, not a pattern.
    const email = member.email?.replace(/[\\%_]/g, '\\$&');
    return email ? [...owned, ...await rows(query().ilike('attendee_email', email))] : owned;
  };
  const standard = await bookings('booking', 'event_id');
  const complex = await bookings('complex_event_booking', 'event_id, ticket_class_id');
  if (links.some(l => !l.session_id && [...standard, ...complex].some(b => b.event_id === l.event_id))) return true;
  const sessionLinks = links.filter(l => l.session_id);
  if (!sessionLinks.length || !complex.length) return false;
  const ticketIds = [...new Set(complex.map(b => b.ticket_class_id).filter(Boolean))];
  // Preserve check-event-access's outer gate: ticketless-only bookings never
  // reach session evaluation (even for a session with no tracks).
  if (!ticketIds.length) return false;
  const sessions = await rows(db.from('complex_event_session').select('id, complex_event_id')
    .eq('tenant_id', ctx.tenantId).in('id', sessionLinks.map(l => l.session_id)));
  const tracks = sessions.length ? await rows(db.from('complex_event_session_track')
    .select('complex_event_session_id, complex_event_track_id')
    .eq('tenant_id', ctx.tenantId).in('complex_event_session_id', sessions.map(s => s.id))) : [];
  const tickets = ticketIds.length ? await rows(db.from('complex_event_ticket_class')
    .select('id, complex_event_id, linked_track_ids, all_tracks')
    .eq('tenant_id', ctx.tenantId).in('id', ticketIds)) : [];
  return sessionLinks.some(link => {
    if (!sessions.some(s => s.id === link.session_id && s.complex_event_id === link.event_id)) return false;
    const sessionTracks = tracks.filter(t => t.complex_event_session_id === link.session_id).map(t => t.complex_event_track_id);
    return complex.filter(b => b.event_id === link.event_id).some(b => {
      if (!sessionTracks.length || !b.ticket_class_id) return true;
      const ticket = tickets.find(t => t.id === b.ticket_class_id && t.complex_event_id === link.event_id);
      return ticket && (ticket.all_tracks || sessionTracks.some(id => (ticket.linked_track_ids || []).includes(id)));
    });
  });
}

export async function readSingleResource({ db, ctx, id, isAdmin, categoryPrivileged, canAdministerGroupContent = false, eventAccess = canAccessResourceEvents, now = Date.now() }) {
  const resources = await rows(db.from('resource').select('*')
    .eq('tenant_id', ctx.tenantId).eq('id', id).eq('status', 'active').limit(1));
  const resource = resources[0];
  if (!resource || !isResourceReleased(resource, now)) return null;
  if (!isAdmin && resource.is_public !== true &&
      (!ctx.roleId || (resource.allowed_role_ids?.length && !resource.allowed_role_ids.includes(ctx.roleId)))) return null;
  if (resource.member_group_id) {
    const groups = await rows(db.from('member_group').select('id, resource_subcategories, is_active')
      .eq('tenant_id', ctx.tenantId).eq('id', resource.member_group_id).limit(1));
    const group = groups[0];
    if (!group || group.is_active === false) return null;
    const shared = (resource.subcategories || []).some(s => (group.resource_subcategories || []).includes(s));
    if (!shared && !canAdministerGroupContent) {
      if (!ctx.memberId) return null;
      const assignments = await rows(db.from('member_group_assignment').select('expires_at')
        .eq('group_id', group.id).eq('member_id', ctx.memberId));
      if (!assignments.some(a => !a.expires_at || Date.parse(a.expires_at) > now)) return null;
    }
  }
  const categories = await fetchCategoriesWithAccess(db, ctx.tenantId);
  const hidden = computeHiddenSubcategories(categories, { roleId: ctx.roleId, isPrivileged: categoryPrivileged });
  if (isResourceHiddenByCategories(resource, hidden)) return null;
  if (!isAdmin && !await eventAccess(db, resource, ctx)) return null;
  // No access configuration or hidden category names in the display response.
  const { allowed_role_ids, ...visible } = resource;
  return { ...visible, subcategories: (resource.subcategories || []).filter(s => !hidden.has(s)) };
}

export function createSingleResourceHandler({ db, getContext, hasAdminAccess, hasFeatureAccess }) {
  return async (req, res) => {
    const now = Date.now();
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const ctx = await getContext(req);
      if (!ctx?.isAuthenticated || !ctx.tenantId || ctx.tenantMismatch) {
        return res.status(401).json({ error: 'Please sign in to view this resource.' });
      }
      const id = req.query.id;
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(404).json({ error: 'Resource not found or unavailable.' });
      }
      if (!db) return res.status(503).json({ error: 'Resource service unavailable.' });
      const isAdmin = !!ctx.tenantUserId || await hasAdminAccess(ctx);
      const categoryPrivileged = isAdmin || (ctx.roleId ? await hasFeatureAccess(ctx.roleId, 'content.resource-management') : false);
      // MemberGroupDetail's narrow isEventAdmin entitlement, including per-member
      // exclusions. This bypasses only the group-membership gate, not role,
      // category, active-status or attendance checks.
      const canAdministerGroupContent = ctx.roleId
        ? await hasFeatureAccess(ctx.roleId, 'events.browse-events.create', ctx.memberExcludedFeatures || [])
        : false;
      const resource = await readSingleResource({ db, ctx, id, isAdmin, categoryPrivileged, canAdministerGroupContent, now });
      if (!resource) return res.status(404).json({ error: 'Resource not found or unavailable.' });
      return res.status(200).json(resource);
    } catch (error) {
      console.error('[resources/single] Failed to load resource:', error?.message);
      return res.status(500).json({ error: 'Unable to load this resource. Please try again.' });
    }
  };
}