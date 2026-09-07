import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import { supabase } from '../../_lib/database.js';
import {
  getCallerGroupEventsAccess,
  getCallerGroupMembershipIds,
} from '../../_lib/memberGroupEventsAccess.js';
import { filterCountableEvents } from '../../_lib/eventAttendeeCountAccess.js';

const ATTENDEE_VIEW_FEATURE = 'events.browse-events.view-attendees';
const MAX_EVENT_IDS = 500;
const PAGE_SIZE = 1000;

function normalizeEventIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && id.length > 0))];
}

async function addTableCounts({ table, eventIds, tenantId, counts }) {
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('id,event_id,status')
      .eq('tenant_id', tenantId)
      .in('event_id', eventIds)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw error;
    for (const booking of data || []) {
      if (booking.status !== 'cancelled' && counts[booking.event_id] !== undefined) {
        counts[booking.event_id] += 1;
      }
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
}

async function loadEventRows(table, eventIds, tenantId) {
  if (eventIds.length === 0) return [];
  const { data, error } = await supabase
    .from(table)
    .select('id,tenant_id,member_group_id,group_event_public')
    .eq('tenant_id', tenantId)
    .in('id', eventIds);
  if (error) throw error;
  return data || [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const context = await getTenantContext(req);
  if (!context.isAuthenticated || !context.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const simpleEventIds = normalizeEventIds(req.body?.simpleEventIds);
  const complexEventIds = normalizeEventIds(req.body?.complexEventIds);
  if (simpleEventIds.length + complexEventIds.length > MAX_EVENT_IDS) {
    return res.status(400).json({ error: `A maximum of ${MAX_EVENT_IDS} events may be requested` });
  }

  if (simpleEventIds.length + complexEventIds.length === 0) {
    return res.status(200).json({ counts: {} });
  }

  try {
    const [
      isTenantAdmin,
      hasGlobalAttendeeAccess,
      membershipAccess,
      groupAdminAccess,
      simpleRows,
      complexRows,
    ] = await Promise.all([
      hasAdminAccess(context),
      hasFeatureAccess(context.roleId, ATTENDEE_VIEW_FEATURE),
      getCallerGroupMembershipIds(req),
      getCallerGroupEventsAccess(req),
      loadEventRows('event', simpleEventIds, context.tenantId),
      loadEventRows('complex_event', complexEventIds, context.tenantId),
    ]);
    const administeredGroupIds = new Set(
      (groupAdminAccess.groups || []).map((group) => group.groupId),
    );
    const accessArgs = {
      tenantId: context.tenantId,
      isTenantAdmin,
      hasGlobalAttendeeAccess,
      memberGroupIds: membershipAccess.groupIds,
      administeredGroupIds,
    };
    const allowedSimpleIds = filterCountableEvents({ ...accessArgs, rows: simpleRows })
      .map((event) => event.id);
    const allowedComplexIds = filterCountableEvents({ ...accessArgs, rows: complexRows })
      .map((event) => event.id);
    if (allowedSimpleIds.length === 0 && allowedComplexIds.length === 0) {
      return res.status(403).json({ error: 'Attendee access required' });
    }

    const counts = Object.fromEntries(
      [...allowedSimpleIds, ...allowedComplexIds].map((eventId) => [eventId, 0]),
    );
    await Promise.all([
      allowedSimpleIds.length > 0 && addTableCounts({
        table: 'booking',
        eventIds: allowedSimpleIds,
        tenantId: context.tenantId,
        counts,
      }),
      allowedComplexIds.length > 0 && addTableCounts({
        table: 'complex_event_booking',
        eventIds: allowedComplexIds,
        tenantId: context.tenantId,
        counts,
      }),
    ]);
    return res.status(200).json({ counts });
  } catch (error) {
    console.error('[Event attendee counts] Query failed:', error);
    return res.status(500).json({ error: 'Failed to load attendee counts' });
  }
}