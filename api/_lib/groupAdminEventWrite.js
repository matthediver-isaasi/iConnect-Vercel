import { supabase } from './database.js';
import { hasAdminAccess } from './tenantContext.js';
import { getCallerGroupEventsAccess } from './memberGroupEventsAccess.js';
import {
  SIMPLE_EVENT_TIMING,
  normalizeSimpleEventWrite,
} from '../../shared/eventTiming.js';

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
 * Immediate simple-event timing is validated for every caller before the
 * group-admin-specific rules run. All other tenant-admin writes pass through.
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

/**
 * Task #1523: fields the group-limited event editor UI (Task #1522) HIDES.
 * Hiding inputs is not access control — a crafted API request could still set a
 * Featured flag, add speakers, set a CTA override, enable seat/availability
 * display, etc. Coerce each to the neutral default the hidden control would have
 * produced so group events behave exactly as the UI implies.
 *
 * Only fields actually present in the payload are touched. This keeps partial
 * (PATCH) updates safe and tolerates the column differences between the `event`
 * and `complex_event` tables (e.g. `event` has `speaker_ids`, `complex_event`
 * does not) without writing columns that do not exist.
 */
function normalizeHiddenGroupEventFields(out) {
  if (!out || typeof out !== 'object') return;
  if ('is_featured' in out) out.is_featured = false;
  if ('status' in out && out.status === 'tbc') out.status = 'published';
  if ('qr_on_confirmation' in out) out.qr_on_confirmation = false;
  if ('show_seat_count' in out) out.show_seat_count = true;
  if ('show_ticket_availability' in out) out.show_ticket_availability = false;
  if ('speaker_ids' in out) out.speaker_ids = [];
  // Task #3285: speaker awards are money-like (training vouchers) and admin-only;
  // group admins must never configure them via crafted requests.
  if ('speaker_award_config' in out) out.speaker_award_config = null;
  if ('speaker_awards_granted_at' in out) delete out.speaker_awards_granted_at;
  if ('event_type' in out) out.event_type = null;
  if ('internal_reference' in out) out.internal_reference = null;
  if ('cta_override_url' in out) out.cta_override_url = null;
  if ('cta_override_mode' in out) out.cta_override_mode = 'card';
  if ('cta_button_label' in out) out.cta_button_label = null;
  // Budget figures are financial, admin-only data (the Budget tab is hidden in
  // group-limited mode); drop them so group-admin saves never touch or clear
  // values a tenant admin may have set.
  if ('budgeted_costs' in out) delete out.budgeted_costs;
  if ('budgeted_income' in out) delete out.budgeted_income;
  if ('dietary_options' in out) out.dietary_options = [];
  if ('allergy_options' in out) out.allergy_options = [];
  if ('accessibility_options' in out) out.accessibility_options = [];

  // Guest-view-all and third-party-consent toggles live inside pricing_config.
  const pc = out.pricing_config;
  if (pc && typeof pc === 'object' && !Array.isArray(pc)) {
    if ('allowGuestsToViewAllTickets' in pc) pc.allowGuestsToViewAllTickets = false;
    if ('collectThirdPartyConsent' in pc) pc.collectThirdPartyConsent = false;
  }
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
  return authorizeGroupAdminEventAction({
    eventId,
    eventTable,
    tenantCtx,
    req,
    denialError: 'You can only delete events for groups you administer',
  });
}

/**
 * Task e1476154: shared authorization for group-admin event ACTIONS on an
 * existing event (delete-preview, delete, duplicate, attendee management).
 * Tenant admins always pass. A Group Admin passes only when the target event
 * belongs to an events-enabled group they administer (active assignment,
 * active group, same tenant). When `requireTypeEnabled` is true the group's
 * per-type flag (events_enabled / complex_events_enabled) must also allow the
 * event's type — used for duplicate, which creates a new event.
 *
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export async function authorizeGroupAdminEventAction({
  eventId,
  eventTable,
  tenantCtx,
  req,
  requireTypeEnabled = false,
  denialError = 'You can only manage events for groups you administer',
}) {
  if (await hasAdminAccess(tenantCtx)) return { ok: true };

  const access = await getCallerGroupEventsAccess(req);
  if (access.error) {
    return { ok: false, status: access.status || 403, error: access.error };
  }

  const table = eventTable === 'complex_event' ? 'complex_event' : 'event';
  if ((access.groups || []).length === 0) {
    return { ok: false, status: 403, error: 'You do not have permission to manage events' };
  }
  const { data: row } = await supabase
    .from(table)
    .select('id, member_group_id, tenant_id')
    .eq('id', eventId)
    .maybeSingle();

  return evaluateGroupAdminEventAction({
    row,
    table,
    tenantId: tenantCtx.tenantId,
    adminGroups: access.groups || [],
    requireTypeEnabled,
    denialError,
  });
}

/**
 * Pure decision core for group-admin event ACTION authorization — exported for
 * unit tests. `row` is the target event row (id, member_group_id, tenant_id)
 * or null when not found; `adminGroups` is getCallerGroupEventsAccess().groups.
 */
export function evaluateGroupAdminEventAction({
  row,
  table,
  tenantId,
  adminGroups,
  requireTypeEnabled = false,
  denialError = 'You can only manage events for groups you administer',
}) {
  const adminGroupIds = new Set((adminGroups || []).map((g) => g.groupId));
  if (adminGroupIds.size === 0) {
    return { ok: false, status: 403, error: 'You do not have permission to manage events' };
  }
  if (!row) return { ok: false, status: 404, error: 'Event not found' };
  if (tenantId && row.tenant_id && row.tenant_id !== tenantId) {
    return { ok: false, status: 403, error: 'Event not found in this tenant' };
  }
  if (!row.member_group_id || !adminGroupIds.has(row.member_group_id)) {
    return { ok: false, status: 403, error: denialError };
  }
  if (requireTypeEnabled) {
    const flags = (adminGroups || []).find((g) => g.groupId === row.member_group_id);
    const allowed = table === 'complex_event' ? flags?.complexEnabled === true : flags?.simpleEnabled === true;
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        error: table === 'complex_event'
          ? 'This group does not allow multi-session events'
          : 'This group does not allow simple events',
      };
    }
  }
  return { ok: true };
}

/**
 * Task e1476154: boolean group-admin check for the admin attendee endpoints
 * (/api/admin/events/[eventId]/attendees/*), which receive either a simple
 * event id or a complex event id in the same parameter. Resolves the id
 * against both tables and returns true only when the event belongs to a group
 * the caller administers.
 */
export async function isGroupAdminForEventRequest(req, eventId) {
  if (!supabase || !eventId) return false;
  try {
    const access = await getCallerGroupEventsAccess(req);
    if (access.error) return false;
    const adminGroupIds = new Set((access.groups || []).map((g) => g.groupId));
    if (adminGroupIds.size === 0) return false;

    const tenantId = access.tenantContext?.tenantId || null;
    for (const table of ['event', 'complex_event']) {
      const { data: row } = await supabase
        .from(table)
        .select('id, member_group_id, tenant_id')
        .eq('id', eventId)
        .maybeSingle();
      if (!row) continue;
      if (tenantId && row.tenant_id && row.tenant_id !== tenantId) return false;
      return !!row.member_group_id && adminGroupIds.has(row.member_group_id);
    }
    return false;
  } catch (e) {
    console.error('[isGroupAdminForEventRequest] error:', e);
    return false;
  }
}

export async function authorizeGroupAdminEventWrite({ entity, op, body, existingRow = null, tenantCtx, req }) {
  const n = norm(entity);
  if (!EVENT_FAMILY.has(n)) return { ok: true, body };

  let timingGuardedBody = body;
  if (n === 'event') {
    const timing = normalizeSimpleEventWrite(body, existingRow);
    if (!timing.ok) return timing;
    timingGuardedBody = timing.body;
  } else if (
    n === 'complexevent' &&
    body?.status === SIMPLE_EVENT_TIMING.IMMEDIATE
  ) {
    return {
      ok: false,
      status: 400,
      error: 'Immediate access is not available for multi-session events',
    };
  }

  // Tenant admins keep the full write path after the timing invariant is
  // enforced and immediate schedule fields are normalized.
  const isAdmin = await hasAdminAccess(tenantCtx);
  if (isAdmin) return { ok: true, body: timingGuardedBody };

  // Non-admin caller: must be a Group Admin of at least one events-enabled group.
  const access = await getCallerGroupEventsAccess(req);
  if (access.error) {
    return { ok: false, status: access.status || 403, error: access.error };
  }
  const adminGroupIds = new Set((access.groups || []).map((g) => g.groupId));
  if (adminGroupIds.size === 0) {
    return { ok: false, status: 403, error: 'You do not have permission to manage events' };
  }

  // Task #1561: per-group split flags. simpleEnabled gates simple `event`
  // writes; complexEnabled gates `complex_event` (and its children) writes.
  const groupFlags = new Map((access.groups || []).map((g) => [g.groupId, g]));
  const groupAllowsSimple = (groupId) => groupFlags.get(groupId)?.simpleEnabled === true;
  const groupAllowsComplex = (groupId) => groupFlags.get(groupId)?.complexEnabled === true;

  const out = { ...timingGuardedBody };

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
    if (n === 'event' && !groupAllowsSimple(groupId)) {
      return { ok: false, status: 403, error: 'This group does not allow simple events' };
    }
    if (n === 'complexevent' && !groupAllowsComplex(groupId)) {
      return { ok: false, status: 403, error: 'This group does not allow multi-session events' };
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
        if (tcs.length > 1) {
          return { ok: false, status: 403, error: 'Group events can only have one ticket type' };
        }
        for (const tc of tcs) {
          if (!isFreeTicket(tc)) {
            return { ok: false, status: 403, error: 'Group events can only offer free tickets' };
          }
        }
      }
    }

    // Task #1523: coerce the controls the group-limited UI hides (featured, tbc
    // timing, QR, speakers, event type, internal reference, CTA override, seat /
    // availability display, dietary/allergy/accessibility, guest-view-all,
    // third-party consent) to their neutral defaults.
    normalizeHiddenGroupEventFields(out);
    return { ok: true, body: out };
  }

  // ---- Complex children: parent complex_event must belong to an administered group ----
  if (n === 'complexeventticketclass') {
    const ceId = op === 'create' ? out.complex_event_id : existingRow?.complex_event_id;
    const parent = await parentComplexEvent(ceId);
    if (!parent || !parent.member_group_id || !adminGroupIds.has(parent.member_group_id)) {
      return { ok: false, status: 403, error: 'You can only manage tickets for events you administer' };
    }
    if (!groupAllowsComplex(parent.member_group_id)) {
      return { ok: false, status: 403, error: 'This group does not allow multi-session events' };
    }
    if (!isFreeTicket(out)) {
      return { ok: false, status: 403, error: 'Group events can only offer free tickets' };
    }
    // Task #1523: group events are limited to a single ticket type. Block adding
    // a second ticket class to an administered group's complex event.
    if (op === 'create') {
      const { count } = await supabase
        .from('complex_event_ticket_class')
        .select('id', { count: 'exact', head: true })
        .eq('complex_event_id', ceId);
      if ((count || 0) >= 1) {
        return { ok: false, status: 403, error: 'Group events can only have one ticket type' };
      }
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
    if (!groupAllowsComplex(parent.member_group_id)) {
      return { ok: false, status: 403, error: 'This group does not allow multi-session events' };
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
    if (!groupAllowsComplex(parent.member_group_id)) {
      return { ok: false, status: 403, error: 'This group does not allow multi-session events' };
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
