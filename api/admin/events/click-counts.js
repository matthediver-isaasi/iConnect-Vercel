import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../../_lib/tenantContext.js';
import {
  getCallerGroupEventsAccess,
  getCallerGroupMembershipIds,
} from '../../_lib/memberGroupEventsAccess.js';
import { filterCountableEvents } from '../../_lib/eventAttendeeCountAccess.js';
import { isUuid } from '../../_lib/eventClickTracking.js';

const ATTENDEE_VIEW_FEATURE = 'events.browse-events.view-attendees';
const MAX_EVENT_IDS = 500;

function normalizeEventIds(value) {
  if (!Array.isArray(value)) return { ids: [], invalid: true };
  const ids = [...new Set(value.map((id) => (
    typeof id === 'string' ? id.trim().toLowerCase() : id
  )))];
  return {
    ids,
    invalid: ids.some((id) => !isUuid(id)),
  };
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
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const context = await getTenantContext(req);
  if (context?.tenantMismatch) {
    return res.status(409).json({ error: 'Session tenant changed — please reload.' });
  }
  if (!context?.isAuthenticated || !context?.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const simple = normalizeEventIds(req.body?.simpleEventIds);
  const complex = normalizeEventIds(req.body?.complexEventIds);
  const allIds = [...simple.ids, ...complex.ids];
  if (simple.invalid || complex.invalid) {
    return res.status(400).json({ error: 'Event ids must be UUIDs' });
  }
  if (allIds.length > MAX_EVENT_IDS) {
    return res.status(400).json({ error: `A maximum of ${MAX_EVENT_IDS} events may be requested` });
  }

  const emptyCounts = { simple: {}, complex: {} };
  if (allIds.length === 0) return res.status(200).json({ counts: emptyCounts });

  try {
    // These checks deliberately mirror /api/admin/events/attendee-counts.js.
    // In particular, private group events are filtered by the shared
    // filterCountableEvents policy rather than by a looser admin-only check.
    const [
      isTenantAdmin,
      hasGlobalAttendeeAccess,
      membershipAccess,
      groupAdminAccess,
      simpleRows,
      complexRows,
    ] = await Promise.all([
      hasAdminAccess(context),
      hasFeatureAccess(
        context.roleId,
        ATTENDEE_VIEW_FEATURE,
        context.memberExcludedFeatures,
      ),
      getCallerGroupMembershipIds(req),
      getCallerGroupEventsAccess(req),
      loadEventRows('event', simple.ids, context.tenantId),
      loadEventRows('complex_event', complex.ids, context.tenantId),
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

    const counts = {
      simple: Object.fromEntries(allowedSimpleIds.map((id) => [id, 0])),
      complex: Object.fromEntries(allowedComplexIds.map((id) => [id, 0])),
    };
    const { data, error } = await supabase.rpc('get_event_card_click_counts', {
      p_tenant_id: context.tenantId,
      p_simple_event_ids: allowedSimpleIds,
      p_complex_event_ids: allowedComplexIds,
    });
    if (error) throw error;

    for (const row of data || []) {
      const type = row.event_type === 'complex' ? 'complex' : 'simple';
      if (Object.prototype.hasOwnProperty.call(counts[type], row.event_id)) {
        counts[type][row.event_id] = Number(row.click_count) || 0;
      }
    }
    return res.status(200).json({ counts });
  } catch (error) {
    console.error('[Event click counts] Query failed:', error);
    return res.status(500).json({ error: 'Failed to load event click counts' });
  }
}