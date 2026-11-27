// Per-event "Members can register others" setting (simple and complex events).
// Missing/legacy values mean allowed, so existing events keep current behaviour.
// Applies to signed-in members only; non-members and admin booking tools are
// governed elsewhere.

export const REGISTER_OTHERS_DISABLED_MESSAGE =
  'This event only allows members to register themselves. Remove the other attendees and try again.';

export function membersCanRegisterOthers(event) {
  return event?.members_can_register_others !== false;
}

const normEmail = value => String(value || '').trim().toLowerCase();

/**
 * Returns null when the attendee list is acceptable for a member booking,
 * otherwise the user-facing rejection message. Only the booking member
 * (matched by email) may appear, at most once.
 */
export function memberSelfOnlyViolation(event, attendees, memberEmail) {
  if (membersCanRegisterOthers(event)) return null;
  const self = normEmail(memberEmail);
  const list = Array.isArray(attendees) ? attendees : [];
  if (!self || list.length !== 1 || normEmail(list[0]?.email) !== self) {
    return REGISTER_OTHERS_DISABLED_MESSAGE;
  }
  return null;
}
