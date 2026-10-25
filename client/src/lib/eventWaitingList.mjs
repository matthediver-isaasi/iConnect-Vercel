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

export function withdrawWaitingListEntries(entries, target) {
  return entries.filter(entry => target.scope === 'registration'
    ? entry.registration_id !== target.entry.registration_id
    : entry.id !== target.entry.id);
}
