import { supabase } from './database.js';
import { hasAdminAccess } from './tenantContext.js';
import { getCallerGroupEventsAccess } from './memberGroupEventsAccess.js';

/**
 * Task #1519: Server-side authorization + guardrails for Group-Admin event writes.
 *
 * Group Admins (per-assignment is_group_admin flag) of events-enabled groups may
 * create/update the REAL simple (Event) and complex (ComplexEvent + children)
 * events — but ONLY for groups they administer, and ONLY within three guardrails:
 *   1. Free tickets only (no paid / early-bird / group / offer tickets).
 *   2. Manual online only — no Zoom; online events need a pasted meeting link.
 *   3. The event is locked to an administered member_group_id; audience is a
 *      per-event group-only (default) / public choice (group_event_public).
 *
 * Tenant admins (tenant users OR members with an admin role) are unaffected —
 * their writes pass straight through unchanged.
 *
 * The generic entity API has no server-side admin gate on tenant-scoped event
 * writes today (RBAC is client-side), so this layer TIGHTENS security: a
 * non-admin caller can now only write group events they administer.
 *
 * @returns {{ ok: true, body: object } | { ok: false, status: number, error: string }}
 */
const EVENT_FAMILY = new Set([
  'event',
  'complexevent',
  'complexeventticketclass',
  'complexeventsession',
  'complexeventtrack',
  'eventsponsorassignment',
]);

function norm(entity) {
  return String(entity || '').replace(/[-_]/g, '').toLowerCase();
}

export function isEventFamilyEntity(entity) {
  return EVENT_FAMILY.has(norm(entity));
}

/**
 * A ticket class is permitted for a group event only when it is genuinely free:
 * zero price, no early bird, no group ticket, no special offer.
 */
function isFreeTicket(tc) {
  if (!tc || typeof tc !== 'object') return true;
  const price = Number(tc.price ?? 0) || 0;
  const ebPrice = Number(tc.early_bird_price ?? 0) || 0;
  const free = tc.is_free === true || price === 0;
  if (!free) return false;
  if (price > 0 || ebPrice > 0) return false;
  if (tc.early_bird_enabled === true) return false;
  if (tc.is_group_ticket === true) return false;
  if (tc.offer_type && tc.offer_type !== 'none') return false;
  return true;
}

async function parentComplexEvent(complexEventId) {
  if (!complexEventId) return null;
  const { data } = await supabase
    .from('complex_event')
    .select('id, member_group_id, tenant_id')
    .eq('id', complexEventId)
    .maybeSingle();
  return data || null;
}

async function trackComplexEventId(trackId) {
  if (!trackId) return null;
  const { data } = await supabase
    .from('complex_event_track')
    .select('complex_event_id')
    .eq('id', trackId)
    .maybeSingle();
  return data?.complex_event_id || null;
}

async function simpleEventGroup(eventId) {
  if (!eventId) return null;
  const { data } = await supabase
    .from('event')
    .select('id, member_group_id')
    .eq('id', eventId)
    .maybeSingle();
  return data || null;
}

/**
 * Authorize a delete-with-cancellations call. Tenant admins are always allowed.
 * A Group Admin is allowed only when the target event belongs to a group they
 * administer.
 *
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export async function authorizeGroupAdminEventDelete({ eventId, eventTable, tenantCtx, req }) {
  if (await hasAdminAccess(tenantCtx)) return { ok: true };

  const access = await getCallerGroupEventsAccess(req);
  if (access.error) {
    return { ok: false, status: access.status || 403, error: access.error };
  }
  const adminGroupIds = new Set((access.groups || []).map((g) => g.groupId));
  if (adminGroupIds.size === 0) {
    return { ok: false, status: 403, error: 'You do not have permission to manage events' };
  }

  const table = eventTable === 'complex_event' ? 'complex_event' : 'event';
  const { data: row } = await supabase
    .from(table)
    .select('id, member_group_id, tenant_id')
    .eq('id', eventId)
    .maybeSingle();
  if (!row) return { ok: false, status: 404, error: 'Event not found' };
  if (tenantCtx.tenantId && row.tenant_id && row.tenant_id !== tenantCtx.tenantId) {
    return { ok: false, status: 403, error: 'Event not found in this tenant' };
  }
  if (!row.member_group_id || !adminGroupIds.has(row.member_group_id)) {
    return { ok: false, status: 403, error: 'You can only delete events for groups you administer' };
  }
  return { ok: true };
}

export async function authorizeGroupAdminEventWrite({ entity, op, body, existingRow = null, tenantCtx, req }) {
  const n = norm(entity);
  if (!EVENT_FAMILY.has(n)) return { ok: true, body };

  // Tenant admins keep the full, unchanged write path.
  const isAdmin = await hasAdminAccess(tenantCtx);
  if (isAdmin) return { ok: true, body };

  // Non-admin caller: must be a Group Admin of at least one events-enabled group.
  const access = await getCallerGroupEventsAccess(req);
  if (access.error) {
    return { ok: false, status: access.status || 403, error: access.error };
  }
  const adminGroupIds = new Set((access.groups || []).map((g) => g.groupId));
  if (adminGroupIds.size === 0) {
    return { ok: false, status: 403, error: 'You do not have permission to manage events' };
  }

  const out = { ...body };

  // ---- Parent events (Event / ComplexEvent) ----
  if (n === 'event' || n === 'complexevent') {
    let groupId;
    if (op === 'create') {
      groupId = out.member_group_id || null;
    } else {
      groupId = existingRow?.member_group_id || null;
      if ('member_group_id' in out && out.member_group_id && out.member_group_id !== groupId) {
        return { ok: false, status: 403, error: 'Cannot move a group event to a different group' };
      }
    }
    if (!groupId || !adminGroupIds.has(groupId)) {
      return { ok: false, status: 403, error: 'You can only manage events for groups you administer' };
    }
    out.member_group_id = groupId;
    out.group_event_public = out.group_event_public === true;

    if (n === 'event') {
      if (out.zoom_webinar_id || out.zoom_meeting_id) {
        return { ok: false, status: 403, error: 'Zoom is not available for group events' };
      }
      out.zoom_webinar_id = null;
      out.zoom_meeting_id = null;
      if (out.is_online === true) {
        const link = out.online_meeting_url || out.cta_override_url;
        if (!link || !String(link).trim()) {
          return { ok: false, status: 400, error: 'Online group events need a meeting link' };
        }
      }
      const tcs = out?.pricing_config?.ticket_classes;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          if (!isFreeTicket(tc)) {
            return { ok: false, status: 403, error: 'Group events can only offer free tickets' };
          }
        }
      }
    }
    return { ok: true, body: out };
  }

  // ---- Complex children: parent complex_event must belong to an administered group ----
  if (n === 'complexeventticketclass') {
    const ceId = op === 'create' ? out.complex_event_id : existingRow?.complex_event_id;
    const parent = await parentComplexEvent(ceId);
    if (!parent || !parent.member_group_id || !adminGroupIds.has(parent.member_group_id)) {
      return { ok: false, status: 403, error: 'You can only manage tickets for events you administer' };
    }
    if (!isFreeTicket(out)) {
      return { ok: false, status: 403, error: 'Group events can only offer free tickets' };
    }
    out.is_free = true;
    out.price = 0;
    return { ok: true, body: out };
  }

  if (n === 'complexeventsession') {
    const trackId = op === 'create' ? out.complex_event_track_id : existingRow?.complex_event_track_id;
    const ceId = await trackComplexEventId(trackId);
    const parent = await parentComplexEvent(ceId);
    if (!parent || !parent.member_group_id || !adminGroupIds.has(parent.member_group_id)) {
      return { ok: false, status: 403, error: 'You can only manage sessions for events you administer' };
    }
    if (out.zoom_meeting_id || out.zoom_webinar_id || (out.zoom_type && out.zoom_type !== 'none') || out.auto_create_zoom === true) {
      return { ok: false, status: 403, error: 'Zoom is not available for group events' };
    }
    out.zoom_type = null;
    out.auto_create_zoom = false;
    out.zoom_meeting_id = null;
    out.zoom_webinar_id = null;
    return { ok: true, body: out };
  }

  if (n === 'complexeventtrack') {
    const ceId = op === 'create' ? out.complex_event_id : existingRow?.complex_event_id;
    const parent = await parentComplexEvent(ceId);
    if (!parent || !parent.member_group_id || !adminGroupIds.has(parent.member_group_id)) {
      return { ok: false, status: 403, error: 'You can only manage tracks for events you administer' };
    }
    return { ok: true, body: out };
  }

  if (n === 'eventsponsorassignment') {
    // Assignment may target a simple event_id or a complex_event_id.
    const eventId = op === 'create' ? out.event_id : existingRow?.event_id;
    const ceId = op === 'create' ? out.complex_event_id : existingRow?.complex_event_id;
    if (ceId) {
      const parent = await parentComplexEvent(ceId);
      if (!parent || !parent.member_group_id || !adminGroupIds.has(parent.member_group_id)) {
        return { ok: false, status: 403, error: 'You can only manage sponsors for events you administer' };
      }
    } else if (eventId) {
      const ev = await simpleEventGroup(eventId);
      if (!ev || !ev.member_group_id || !adminGroupIds.has(ev.member_group_id)) {
        return { ok: false, status: 403, error: 'You can only manage sponsors for events you administer' };
      }
    } else {
      return { ok: false, status: 400, error: 'Sponsor assignment requires an event reference' };
    }
    return { ok: true, body: out };
  }

  return { ok: true, body: out };
}
