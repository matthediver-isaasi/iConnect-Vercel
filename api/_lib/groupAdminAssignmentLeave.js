import { supabase } from './database.js';

/**
 * Tasks #1592 / #1595: Never leave a member group without an active admin.
 *
 * A member group can have one or more group admins (the per-assignment
 * `is_group_admin` flag). There are two entry points that can strip the last
 * admin from a group:
 *   - The self-leave flow on the group detail page deletes the caller's own
 *     MemberGroupAssignment (Task #1592).
 *   - A tenant admin on the group management screens can delete OR demote
 *     (toggle `is_group_admin` off / set a past `expires_at`) any assignment,
 *     including the group's only admin (Task #1595).
 *
 * This guard fires for BOTH entry points: any delete or demotion of an active
 * (non-expired) admin assignment is rejected when no other active admin would
 * remain for the group. The error message is tailored to whether the caller is
 * removing their own assignment (self-leave) or someone else's.
 *
 * "Active admin" mirrors how admin status is determined elsewhere
 * (groupAdminResourceWrite.js / MemberGroupDetail.jsx): is_group_admin === true
 * and either no expires_at or an expires_at in the future.
 */
function norm(entity) {
  return String(entity || '').replace(/[-_]/g, '').toLowerCase();
}

export function isMemberGroupAssignmentEntity(entity) {
  return norm(entity) === 'membergroupassignment';
}

function isActiveAdmin(row, nowIso) {
  if (!row || row.is_group_admin !== true) return false;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).toISOString() > nowIso;
}

/**
 * Compute whether the assignment would STILL be an active admin after applying
 * a PATCH payload. Only the `is_group_admin` and `expires_at` fields can change
 * admin status; any field absent from the patch keeps its existing value.
 */
function remainsActiveAdminAfterPatch(existingRow, patch, nowIso) {
  const next = {
    is_group_admin: 'is_group_admin' in (patch || {}) ? patch.is_group_admin : existingRow.is_group_admin,
    expires_at: 'expires_at' in (patch || {}) ? patch.expires_at : existingRow.expires_at,
  };
  return isActiveAdmin(next, nowIso);
}

/**
 * Authorize a delete or demotion of a MemberGroupAssignment.
 *
 * @param {object} args
 * @param {'delete'|'update'} args.op
 * @param {object|null} args.existingRow - { id, member_id, group_id, is_group_admin, expires_at }
 * @param {object} [args.patch] - sanitized PATCH body (only used when op === 'update')
 * @param {object} args.tenantCtx
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string, code?: string }>}
 */
export async function authorizeMemberGroupAdminAssignmentChange({ op, existingRow, patch, tenantCtx }) {
  // No row to act on — let the normal flow return its own 404.
  if (!existingRow) return { ok: true };

  const nowIso = new Date().toISOString();

  // Only the removal/demotion of a currently-active admin can orphan a group.
  if (!isActiveAdmin(existingRow, nowIso)) return { ok: true };

  // For updates, if the assignment stays an active admin, there is no risk.
  if (op === 'update' && remainsActiveAdminAfterPatch(existingRow, patch, nowIso)) {
    return { ok: true };
  }

  if (!existingRow.group_id || !supabase) return { ok: true };

  const { data: groupAssignments, error } = await supabase
    .from('member_group_assignment')
    .select('id, member_id, is_group_admin, expires_at')
    .eq('group_id', existingRow.group_id);
  if (error) {
    return { ok: false, status: 500, error: 'Failed to verify group admins' };
  }

  const otherActiveAdmins = (groupAssignments || []).filter(
    (a) => a.id !== existingRow.id && isActiveAdmin(a, nowIso)
  );

  if (otherActiveAdmins.length > 0) return { ok: true };

  const callerMemberId = tenantCtx?.memberId || null;
  const isSelf = callerMemberId && existingRow.member_id === callerMemberId;

  return {
    ok: false,
    status: 409,
    code: 'last_group_admin',
    error: isSelf
      ? "You can't leave this group while you're its only admin. Promote another member to admin first."
      : "You can't remove or demote this group's only admin. Promote another member to admin first.",
  };
}

/**
 * Backwards-compatible self-leave guard (Task #1592). Delegates to the general
 * change authorizer with op='delete'.
 */
export async function authorizeMemberGroupAssignmentLeave({ existingRow, tenantCtx }) {
  return authorizeMemberGroupAdminAssignmentChange({ op: 'delete', existingRow, tenantCtx });
}
