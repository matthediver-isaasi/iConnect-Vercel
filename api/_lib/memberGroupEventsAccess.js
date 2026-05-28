import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';

/**
 * Resolve the caller's access to Group Events. Returns two distinct sets:
 *   - canCreate groups: events_enabled === true on the group AND the caller's
 *     active assignment role is in events_enabled_roles.
 *   - canView groups: any active assignment on a group whose events_enabled is
 *     true (so non-creator members can RSVP / see events).
 *
 * Returns { tenantContext, memberId, identityId, groups: [{groupId, groupName,
 * role, allRoles, eventsEnabledRoles, canCreate}] }.
 */
export async function getCallerGroupEventsAccess(req) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return { error: 'Unauthorized - tenant required', status: 401, tenantContext, memberId: null, identityId: null, groups: [] };
  }
  const memberId = tenantContext.memberId;
  if (!memberId) {
    return { error: 'Forbidden - member session required', status: 403, tenantContext, memberId: null, identityId: null, groups: [] };
  }
  if (!supabase) {
    return { error: 'Database not configured', status: 500, tenantContext, memberId, identityId: null, groups: [] };
  }

  const { data: memberRow, error: memberErr } = await supabase
    .from('member')
    .select('identity_id')
    .eq('id', memberId)
    .maybeSingle();
  if (memberErr) {
    return { error: 'Failed to resolve member identity', status: 500, tenantContext, memberId, identityId: null, groups: [] };
  }
  const identityId = memberRow?.identity_id || null;

  const nowIso = new Date().toISOString();

  const { data: assignments, error: assignErr } = await supabase
    .from('member_group_assignment')
    .select('group_id, group_role, expires_at')
    .eq('member_id', memberId);
  if (assignErr) {
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, identityId, groups: [] };
  }

  const liveAssignments = (assignments || []).filter((a) => {
    if (!a.group_id || !a.group_role) return false;
    if (!a.expires_at) return true;
    return new Date(a.expires_at).toISOString() > nowIso;
  });

  if (liveAssignments.length === 0) {
    return { tenantContext, memberId, identityId, groups: [] };
  }

  const groupIds = [...new Set(liveAssignments.map((a) => a.group_id))];

  const { data: groupRows, error: groupErr } = await supabase
    .from('member_group')
    .select('id, name, is_active, events_enabled, events_enabled_roles, roles, tenant_id')
    .eq('tenant_id', tenantContext.tenantId)
    .in('id', groupIds);
  if (groupErr) {
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, identityId, groups: [] };
  }

  const enabledGroups = new Map();
  (groupRows || []).forEach((g) => {
    if (g.is_active === false) return;
    if (g.events_enabled !== true) return;
    enabledGroups.set(g.id, g);
  });

  const seen = new Set();
  const out = [];
  for (const a of liveAssignments) {
    const g = enabledGroups.get(a.group_id);
    if (!g) continue;
    const key = `${a.group_id}::${a.group_role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const allowed = Array.isArray(g.events_enabled_roles) ? g.events_enabled_roles : [];
    out.push({
      groupId: g.id,
      groupName: g.name,
      role: a.group_role,
      allRoles: Array.isArray(g.roles) ? g.roles : [],
      eventsEnabledRoles: allowed,
      canCreate: allowed.includes(a.group_role),
    });
  }

  return { tenantContext, memberId, identityId, groups: out };
}

export function requireGroupEventsAccess(groups, groupId) {
  if (!groupId) return null;
  return groups.find((g) => g.groupId === groupId) || null;
}

/**
 * Helper: looks up the event row, confirms it's a group event the caller
 * has any access to, and returns { event, access } or an { error, status }
 * shape. Used by group-event detail / rsvp / patch / delete endpoints.
 */
export async function loadGroupEventForCaller(req, eventId) {
  if (!supabase) return { error: 'Database not configured', status: 503 };
  if (!eventId) return { error: 'eventId required', status: 400 };

  const access = await getCallerGroupEventsAccess(req);
  if (access.error) return { error: access.error, status: access.status };

  const { data: event, error: evErr } = await supabase
    .from('event')
    .select('*')
    .eq('id', eventId)
    .maybeSingle();
  if (evErr || !event) return { error: 'Event not found', status: 404 };

  if (!event.member_group_id) return { error: 'Not a group event', status: 404 };
  if (event.tenant_id !== access.tenantContext.tenantId) {
    return { error: 'Event not found', status: 404 };
  }

  const groupAccess = requireGroupEventsAccess(access.groups, event.member_group_id);
  if (!groupAccess) {
    return { error: 'You are not a member of this event\'s group', status: 403 };
  }

  return { event, access, groupAccess };
}
