// Public checkout needs these fields for explicit purchaser capture and
// validation. They are hints only; payment handlers reload authoritative policy.
export function publicTicketMemberPolicy(ticket) {
  const enabled = ['public_only', 'members_and_public'].includes(ticket?.visibility_mode)
    && ticket?.create_member_records === true;
  return {
    create_member_records: enabled,
    new_member_role_id: enabled ? ticket.new_member_role_id || null : null,
  };
}
