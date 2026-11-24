export const WAITING_LIST_MESSAGE = "Join the waiting list to register your interest in this event. We'll keep you informed of news and updates as further details become available. Joining the waiting list does not confirm your place, and no payment is required at this stage.";

export function waitingListAttendee(attendee, ticketClassId, sessionIds = []) {
  return {
    first_name: (attendee.first_name || '').trim(),
    last_name: (attendee.last_name || '').trim(),
    email: (attendee.email || '').trim().toLowerCase(),
    ...(attendee.job_title ? { job_title: attendee.job_title.trim() } : {}),
    ...(attendee.member_id ? { member_id: attendee.member_id } : {}),
    ticket_class_id: ticketClassId,
    session_ids: attendee.session_ids || sessionIds,
    option_ids: attendee.option_ids || [],
    dietary_selections: attendee.dietary_selections || [],
    allergy_selections: attendee.allergy_selections || [],
    accessibility_selections: attendee.accessibility_selections || [],
  };
}

// A changed selection starts a new attempt; ambiguous failures retain the key.
export function resolveWaitingListAttempt(previous, payload, createId) {
  const fingerprint = JSON.stringify(payload);
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: createId() };
}

// Ownership alone is not enough to offer a group action. Use the complete
// active member feed, never an event-level count or the dialog's old snapshot.
export function waitingListGroupCount(entries, entry, member) {
  if (!member?.id || !member.tenant_id || !entry?.registration_id ||
      entry.can_manage_registration !== true || entry.booker_member_id !== member.id ||
      entry.tenant_id !== member.tenant_id) return 0;
  const active = entries.filter(row => row.status === 'active' &&
    row.registration_id === entry.registration_id && row.tenant_id === member.tenant_id &&
    row.booker_member_id === member.id);
  if (!active.some(row => row.id === entry.id) || active.length < 2 ||
      !active.some(row => row.member_id !== member.id)) return 0;
  return active.length;
}

export function withdrawWaitingListEntries(entries, target) {
  return entries.filter(entry => target.scope === 'registration'
    ? entry.registration_id !== target.entry.registration_id
    : entry.id !== target.entry.id);
}
