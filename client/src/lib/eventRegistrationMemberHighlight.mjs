// A guest booking can subsequently be linked to a member. Only the resolved
// member link controls this visual cue, never ticket type or organisation.
export function registrationMemberHighlight(attendee) {
  return attendee?.member_id ? '' : 'bg-amber-50/60 dark:bg-amber-950/20';
}
