import { supabase } from './database.js';
import { getTenantContext, hasAdminAccess } from './tenantContext.js';

/**
 * Task #1608: resolve whether the caller may manage a member group (e.g. send
 * role invitations, list/cancel them).
 *
 * Two kinds of caller qualify:
 *   - Tenant admins (admin dashboard session, or a member with the
 *     `admin.role-management` feature) — may manage ANY group in the tenant.
 *   - Active group admins (an active, non-expired member_group_assignment with
 *     `is_group_admin = true`) — may manage only the groups they administer.
 *
 * Returns { tenantContext, isTenantAdmin, memberId, adminGroupIds } on success,
 * or { error, status, ... } when the caller has no management rights at all.
 */
export async function getCallerGroupManageAccess(req) {
  const tenantContext = await getTenantContext(req);
  if (!tenantContext.tenantId) {
    return { error: 'Unauthorized - tenant required', status: 401, tenantContext };
  }
  if (!supabase) {
    return { error: 'Database not configured', status: 500, tenantContext };
  }

  const isTenantAdmin = await hasAdminAccess(tenantContext);
  const memberId = tenantContext.memberId || null;

  let adminGroupIds = [];
  if (!isTenantAdmin && memberId) {
    const nowIso = new Date().toISOString();
    const { data: assignments, error } = await supabase
      .from('member_group_assignment')
      .select('group_id, expires_at, is_group_admin')
      .eq('member_id', memberId);
    if (error) {
      console.error('[MemberGroupAdminAccess] assignment lookup failed:', error.message || error);
      return { error: 'Failed to resolve group access', status: 500, tenantContext, isTenantAdmin, memberId, adminGroupIds: [] };
    }
    adminGroupIds = [...new Set(
      (assignments || [])
        .filter((a) => a.is_group_admin === true && (!a.expires_at || new Date(a.expires_at).toISOString() > nowIso))
        .map((a) => a.group_id)
        .filter(Boolean)
    )];
  }

  if (!isTenantAdmin && adminGroupIds.length === 0) {
    return {
      error: 'You do not have permission to manage group invitations.',
      status: 403,
      tenantContext,
      isTenantAdmin,
      memberId,
      adminGroupIds: [],
    };
  }

  return { tenantContext, isTenantAdmin, memberId, adminGroupIds };
}

/**
 * Assert the caller (from getCallerGroupManageAccess) may act on a group.
 * Tenant admins pass for any group; group admins only for administered groups.
 */
export function canManageGroup(access, groupId) {
  if (!access || !groupId) return false;
  if (access.isTenantAdmin) return true;
  return (access.adminGroupIds || []).includes(groupId);
}
