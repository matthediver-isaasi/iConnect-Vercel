// Role/group restrictions qualify signed-in members, not the public audience.
// Callers must derive authentication from the verified purchaser, never an
// attendee email, guest account provisioned during checkout or request flag.
export function ticketRoleAudienceAllowed(ticket, { authenticated, roleId, groupIds = [] }) {
  if (!authenticated) {
    const visibility = ticket?.visibility_mode
      || (ticket?.is_public === true ? 'members_and_public' : 'members_only');
    return ticket?.audience_mode !== 'selected_members'
      && ['members_and_public', 'public_only'].includes(visibility);
  }
  if (ticket?.visibility_mode === 'public_only') return false;
  if (!ticket?.role_match_only) return true;
  const roles = Array.isArray(ticket.role_ids) ? ticket.role_ids : [];
  const groups = Array.isArray(ticket.member_group_ids) ? ticket.member_group_ids : [];
  if (!roles.length && !groups.length) return true;
  return Boolean(roleId && roles.includes(roleId))
    || (Array.isArray(groupIds) && groupIds.some(id => groups.includes(id)));
}
