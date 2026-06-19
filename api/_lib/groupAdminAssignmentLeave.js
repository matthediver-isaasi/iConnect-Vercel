import { supabase } from './database.js';

/**
 * Task #1592: Block the last group admin from leaving a member group.
 *
 * A member group can have one or more group admins (the per-assignment
 * `is_group_admin` flag). The self-leave flow on the group detail page deletes
 * the caller's own MemberGroupAssignment. If the caller is the SOLE active
 * (non-expired) admin of the group, removing their assignment would leave the
 * group with no admin and no one able to manage it.
 *
 * This guard fires only when the caller is removing THEIR OWN assignment that is
 * an active admin assignment. Removing someone else's assignment (e.g. a tenant
 * admin via the group management screens) is out of scope and passes through.
 *
 * "Active admin" mirrors how admin status is determined elsewhere
 * (groupAdminResourceWrite.js / MemberGroupDetail.jsx): is_group_admin === true
 * and either no expires_at or an expires_at in the future.
 *
 * @param {object} args
 * @param {object|null} args.existingRow - { id, member_id, group_id, is_group_admin, expires_at }
 * @param {object} args.tenantCtx
 * @returns {{ ok: true } | { ok: false, status: number, error: string, code?: string }}
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

export async function authorizeMemberGroupAssignmentLeave({ existingRow, tenantCtx }) {
  // No row to delete — let the normal flow return its own 404.
  if (!existingRow) return { ok: true };

  const callerMemberId = tenantCtx?.memberId || null;

  // Only the self-leave flow is guarded: the caller must be removing their own
  // assignment. Removing another member's assignment is out of scope.
  if (!callerMemberId || existingRow.member_id !== callerMemberId) {
    return { ok: true };
  }

  const nowIso = new Date().toISOString();

  // Only an active admin leaving can orphan the group.
  if (!isActiveAdmin(existingRow, nowIso)) return { ok: true };

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

  if (otherActiveAdmins.length === 0) {
    return {
      ok: false,
      status: 409,
      code: 'last_group_admin',
      error:
        "You can't leave this group while you're its only admin. Promote another member to admin first.",
    };
  }

  return { ok: true };
}
