// Shared ticket access helpers used by both single-style and complex event
// booking endpoints. Extends the existing role_match_only guard so a ticket
// may be restricted by roles AND/OR member groups (OR logic).

export function getTicketRoleIds(ticketClass) {
  return Array.isArray(ticketClass?.role_ids) ? ticketClass.role_ids : [];
}

export function getTicketMemberGroupIds(ticketClass) {
  return Array.isArray(ticketClass?.member_group_ids) ? ticketClass.member_group_ids : [];
}

export function ticketHasAccessRestrictions(ticketClass) {
  if (!ticketClass) return false;
  if (!ticketClass.role_match_only) return false;
  return getTicketRoleIds(ticketClass).length > 0 || getTicketMemberGroupIds(ticketClass).length > 0;
}

export async function getMemberGroupIdsForMember(supabase, memberId) {
  if (!supabase || !memberId) return [];
  const { data, error } = await supabase
    .from('member_group_assignment')
    .select('group_id')
    .eq('member_id', memberId);
  if (error || !Array.isArray(data)) return [];
  return data.map(r => r.group_id).filter(Boolean);
}

/**
 * Task #3508: group events are viewable by everyone but bookable only by
 * ACTIVE members of the linked member group. Active means the assignment has
 * not expired and the group itself is active.
 */
export async function isActiveMemberOfGroup(supabase, memberId, groupId) {
  if (!supabase || !memberId || !groupId) return false;
  const { data: assignments, error } = await supabase
    .from('member_group_assignment')
    .select('group_id, expires_at')
    .eq('member_id', memberId)
    .eq('group_id', groupId);
  if (error || !Array.isArray(assignments)) return false;
  const nowIso = new Date().toISOString();
  const live = assignments.some(a => !a.expires_at || new Date(a.expires_at).toISOString() > nowIso);
  if (!live) return false;
  const { data: group, error: groupErr } = await supabase
    .from('member_group')
    .select('id, is_active')
    .eq('id', groupId)
    .maybeSingle();
  if (groupErr || !group) return false;
  return group.is_active !== false;
}

export function isTicketAccessibleToMember({ ticketClass, memberRoleId, memberGroupIds }) {
  if (!ticketHasAccessRestrictions(ticketClass)) return true;
  const roleIds = getTicketRoleIds(ticketClass);
  const groupIds = getTicketMemberGroupIds(ticketClass);
  if (memberRoleId && roleIds.includes(memberRoleId)) return true;
  const memberGroups = Array.isArray(memberGroupIds) ? memberGroupIds : [];
  if (memberGroups.some(g => groupIds.includes(g))) return true;
  return false;
}
