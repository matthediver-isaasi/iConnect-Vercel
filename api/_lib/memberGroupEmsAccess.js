import { supabase } from './database.js';
import { getTenantContext } from './tenantContext.js';

/**
 * Resolve the list of member_group / role pairs that the calling member is
 * allowed to send group-emails for. The caller qualifies for a group when:
 *   - they have an active assignment (member_group_assignment row),
 *   - the group is active (member_group.is_active = true),
 *   - the assignment has not expired (expires_at IS NULL OR expires_at > now()),
 *   - the assignment's group_role is in member_group.ems_enabled_roles.
 *
 * Returns { tenantContext, memberId, groups: [{ groupId, groupName, role, emsEnabledRoles, allRoles }] }.
 * On 0 qualifying groups the caller list is empty — callers MUST 403.
 *
 * Also exposes a `requireGroupAccess(groups, groupId)` helper to assert the
 * caller can act on a particular group; returns the matched entry or null.
 */

export async function getCallerEmsAccess(req) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return { error: 'Unauthorized - tenant required', status: 401, tenantContext, memberId: null, groups: [] };
  }
  const memberId = tenantContext.memberId;
  if (!memberId) {
    return { error: 'Forbidden - member session required', status: 403, tenantContext, memberId: null, groups: [] };
  }

  if (!supabase) {
    return { error: 'Database not configured', status: 500, tenantContext, memberId, groups: [] };
  }

  const nowIso = new Date().toISOString();

  // Pull the caller's active assignments. Filter expired rows in JS so we can
  // accept either NULL expires_at or a future date without complex Supabase
  // OR syntax.
  const { data: assignments, error: assignErr } = await supabase
    .from('member_group_assignment')
    .select('group_id, group_role, expires_at')
    .eq('member_id', memberId);

  if (assignErr) {
    console.error('[MemberGroupEmsAccess] assignment lookup failed:', assignErr.message || assignErr);
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, groups: [] };
  }

  const liveAssignments = (assignments || []).filter((a) => {
    if (!a.group_id || !a.group_role) return false;
    if (!a.expires_at) return true;
    return new Date(a.expires_at).toISOString() > nowIso;
  });

  if (liveAssignments.length === 0) {
    return { tenantContext, memberId, groups: [] };
  }

  const groupIds = [...new Set(liveAssignments.map((a) => a.group_id))];

  const { data: groupRows, error: groupErr } = await supabase
    .from('member_group')
    .select('id, name, is_active, ems_enabled_roles, roles, tenant_id')
    .eq('tenant_id', tenantContext.tenantId)
    .in('id', groupIds);

  if (groupErr) {
    console.error('[MemberGroupEmsAccess] group lookup failed:', groupErr.message || groupErr);
    return { error: 'Failed to resolve group access', status: 500, tenantContext, memberId, groups: [] };
  }

  const activeGroups = new Map();
  (groupRows || []).forEach((g) => {
    if (g.is_active === false) return;
    activeGroups.set(g.id, g);
  });

  const seen = new Set();
  const qualifying = [];
  for (const a of liveAssignments) {
    const g = activeGroups.get(a.group_id);
    if (!g) continue;
    const allowed = Array.isArray(g.ems_enabled_roles) ? g.ems_enabled_roles : [];
    if (!allowed.includes(a.group_role)) continue;
    const key = `${a.group_id}::${a.group_role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    qualifying.push({
      groupId: g.id,
      groupName: g.name,
      role: a.group_role,
      emsEnabledRoles: allowed,
      allRoles: Array.isArray(g.roles) ? g.roles : [],
    });
  }

  return { tenantContext, memberId, groups: qualifying };
}

export function requireGroupAccess(qualifyingGroups, groupId) {
  if (!groupId) return null;
  return qualifyingGroups.find((g) => g.groupId === groupId) || null;
}

/**
 * Validates a roles[] sub-filter the caller wants to apply within a group:
 * every entry must be one of the group's defined roles. Returns the
 * normalized array (deduped) or null if invalid.
 */
/**
 * Resolve the locked sender identity for a member-originated campaign.
 * Members may NEVER set or change the from-address: the task spec is
 * explicit ("from-address remains the tenant's existing campaign sender").
 * Returns { fromEmail, fromName } where fromEmail comes from the tenant's
 * verified email-domain config and fromName falls back to the group name.
 */
import { getTenantEmailConfig as _getTenantEmailConfig } from './tenantEmailService.js';

export async function resolveMemberCampaignSender(tenantId, group, requestedFromName) {
  const tenantCfg = await _getTenantEmailConfig(tenantId);
  if (!tenantCfg || !tenantCfg.fromEmail) {
    return { error: 'Your tenant has not configured a verified email domain. Ask an admin to set one up before sending group emails.' };
  }
  const fromName = (typeof requestedFromName === 'string' && requestedFromName.trim())
    ? requestedFromName.trim()
    : (group?.groupName || tenantCfg.fromName || 'ICONN');
  return { fromEmail: tenantCfg.fromEmail, fromName };
}

export function normalizeAudienceRoles(group, roles) {
  if (!Array.isArray(roles) || roles.length === 0) return [];
  const allowed = new Set(group.allRoles || []);
  const out = [];
  const seen = new Set();
  for (const r of roles) {
    if (typeof r !== 'string') return null;
    if (!allowed.has(r)) return null;
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}
