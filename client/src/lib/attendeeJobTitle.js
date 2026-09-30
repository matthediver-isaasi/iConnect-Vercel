// Resolve the job title to display for a booking attendee.
// The per-attendee value stored on the booking row (attendee_job_title) always wins.
// For legacy rows without a stored value, fall back to the booker's member-profile
// job title ONLY when the attendee IS the booker (matching email or full name) —
// never attribute the booker's title to a different attendee.
export function resolveAttendeeJobTitle(booking, memberInfo) {
  const stored = (booking?.attendee_job_title || '').trim();
  if (stored) return stored;
  if (!booking?.member_id || !memberInfo) return '';

  const norm = (v) => (v || '').toLowerCase().trim();
  const emailMatch =
    norm(booking.attendee_email) &&
    norm(booking.attendee_email) === norm(memberInfo.email);
  const attendeeName = `${norm(booking.attendee_first_name)} ${norm(booking.attendee_last_name)}`.trim();
  const memberName = `${norm(memberInfo.first_name)} ${norm(memberInfo.last_name)}`.trim();
  const nameMatch = attendeeName && attendeeName === memberName;

  return emailMatch || nameMatch ? (memberInfo.job_title || '') : '';
}
