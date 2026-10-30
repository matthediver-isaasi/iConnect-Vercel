// Public checkout needs these fields for explicit purchaser capture and
// validation. They are hints only; payment handlers reload authoritative policy.
export function publicTicketMemberPolicy(ticket) {
  const publicAudience = ticket?.audience_mode !== 'selected_members'
    && ['public_only', 'members_and_public'].includes(ticket?.visibility_mode);
  const accounts = publicAudience && ticket?.auto_create_guest_accounts === true;
  const enabled = publicAudience && (ticket?.create_member_records === true || accounts);
  return {
    create_member_records: enabled,
    new_member_role_id: enabled ? ticket.new_member_role_id || null : null,
    ...(ticket?.auto_create_guest_accounts !== undefined ? { auto_create_guest_accounts: accounts } : {}),
  };
}
