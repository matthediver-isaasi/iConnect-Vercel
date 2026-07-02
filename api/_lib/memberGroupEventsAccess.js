import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';

/**
 * Task #1519: Group Admins create real events (limited).
 *
 * Resolve the list of member_group entries the calling member ADMINISTERS for
 * the purpose of creating/editing real (simple & complex) events. A caller
 * qualifies for a group when:
 *   - they have an active assignment (member_group_assignment row),
 *   - the assignment is flagged Group Admin (is_group_admin = true),
 *   - the assignment has not expired (expires_at IS NULL OR expires_at > now()),
 *   - the group is active (member_group.is_active != false),
 *   - the group has events enabled (member_group.events_enabled = true).
 *
 * This mirrors the group-email access helper (#1517): access is gated on the
 * explicit per-assignment Group Admin flag, NOT on the assignment's role. The
 * legacy events_enabled_roles role gating is intentionally NOT consulted.
 *
 * Returns { tenantContext, memberId, identityId, groups: [{ groupId, groupName,
 * role, allRoles, canCreate }] }. `canCreate` is always true for returned groups
 * (kept for backwards-compatible call-sites). On 0 qualifying groups the caller
 * list is empty — write call-sites MUST 403.
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
    .select('group_id, group_role, expires_at, is_group_admin')
    .eq('member_id', memberId);
  if (assignErr) {
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, identityId, groups: [] };
  }

  const liveAdminAssignments = (assignments || []).filter((a) => {
    if (!a.group_id || !a.group_role) return false;
    if (a.is_group_admin !== true) return false;
    if (!a.expires_at) return true;
    return new Date(a.expires_at).toISOString() > nowIso;
  });

  if (liveAdminAssignments.length === 0) {
    return { tenantContext, memberId, identityId, groups: [] };
  }

  const groupIds = [...new Set(liveAdminAssignments.map((a) => a.group_id))];

  const { data: groupRows, error: groupErr } = await supabase
    .from('member_group')
    .select('id, name, is_active, events_enabled, complex_events_enabled, roles, tenant_id')
    .eq('tenant_id', tenantContext.tenantId)
    .in('id', groupIds);
  if (groupErr) {
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, identityId, groups: [] };
  }

  // Task #1561: events_enabled is the SIMPLE-events flag; complex_events_enabled
  // is the complex (multi-session) flag. A group qualifies for the events
  // management surfaces when EITHER flag is on; per-type creation is then gated
  // on the matching flag (simpleEnabled / complexEnabled).
  const enabledGroups = new Map();
  (groupRows || []).forEach((g) => {
    if (g.is_active === false) return;
    const simpleEnabled = g.events_enabled === true;
    const complexEnabled = g.complex_events_enabled === true;
    if (!simpleEnabled && !complexEnabled) return;
    enabledGroups.set(g.id, g);
  });

  const seen = new Set();
  const out = [];
  for (const a of liveAdminAssignments) {
    const g = enabledGroups.get(a.group_id);
    if (!g) continue;
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({
      groupId: g.id,
      groupName: g.name,
      role: a.group_role,
      allRoles: Array.isArray(g.roles) ? g.roles : [],
      canCreate: true,
      simpleEnabled: g.events_enabled === true,
      complexEnabled: g.complex_events_enabled === true,
    });
  }

  return { tenantContext, memberId, identityId, groups: out };
}

/**
 * Returns the matched administered-group entry for `groupId`, or null.
 */
export function requireGroupEventsAccess(groups, groupId) {
  if (!groupId) return null;
  return (groups || []).find((g) => g.groupId === groupId) || null;
}

/**
 * Resolve the set of member_group ids the caller is an ACTIVE member of
 * (regardless of admin flag). Used for /Events visibility of group-only events.
 * Returns { tenantContext, memberId, groupIds: Set<string> }.
 */
export async function getCallerGroupMembershipIds(req) {
  const tenantContext = await getTenantContext(req);
  const memberId = tenantContext.memberId;
  if (!tenantContext.tenantId || !memberId || !supabase) {
    return { tenantContext, memberId: memberId || null, groupIds: new Set() };
  }

  const nowIso = new Date().toISOString();
  const { data: assignments } = await supabase
    .from('member_group_assignment')
    .select('group_id, expires_at')
    .eq('member_id', memberId);

  const liveIds = (assignments || [])
    .filter((a) => a.group_id && (!a.expires_at || new Date(a.expires_at).toISOString() > nowIso))
    .map((a) => a.group_id);

  if (liveIds.length === 0) {
    return { tenantContext, memberId, groupIds: new Set() };
  }

  // Restrict to active groups in this tenant.
  const { data: groupRows } = await supabase
    .from('member_group')
    .select('id, is_active, tenant_id')
    .eq('tenant_id', tenantContext.tenantId)
    .in('id', [...new Set(liveIds)]);

  const active = new Set(
    (groupRows || []).filter((g) => g.is_active !== false).map((g) => g.id)
  );
  return { tenantContext, memberId, groupIds: active };
}
