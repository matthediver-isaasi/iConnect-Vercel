// Task #3403: pick the authenticated viewer's booking for an event-linked
// form. A booking made on the viewer's behalf carries the viewer's email in
// attendee_email but the BOOKER's member_id, so matching member_id alone
// wrongly reports "no booking" for attendees. Priority:
//   1. bookings where the viewer is the ATTENDEE (attendee_email match,
//      case-insensitive)
//   2. bookings where the viewer is the booker (member_id match)
// Within each group the most recent (created_at desc) wins; cancelled
// bookings are ignored.

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Builds an ILIKE pattern that matches the email EXACTLY (case-insensitive
// equality, not a pattern match): every LIKE metacharacter (\ % _) is
// escaped so e.g. jo_n@x.org cannot match john@x.org. Returns null when the
// email is empty or contains characters PostgREST filter values cannot
// safely carry — callers then fall back to a member_id-only match.
export function emailExactIlikePattern(email) {
  const e = normalizeEmail(email);
  if (!e || /[,()]/.test(e)) return null;
  return e.replace(/([\\%_])/g, '\\$1');
}

export function pickViewerBooking(bookings, { memberId, email }) {
  const viewerEmail = normalizeEmail(email);
  const candidates = (bookings || []).filter((b) => b && b.status !== 'cancelled');

  const byRecency = (a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    if (tb !== ta) return tb - ta;
    return String(a.id).localeCompare(String(b.id));
  };

  const attendeeMatches = viewerEmail
    ? candidates.filter((b) => normalizeEmail(b.attendee_email) === viewerEmail)
    : [];
  if (attendeeMatches.length > 0) {
    return attendeeMatches.sort(byRecency)[0];
  }

  const bookerMatches = memberId
    ? candidates.filter((b) => b.member_id === memberId)
    : [];
  if (bookerMatches.length > 0) {
    return bookerMatches.sort(byRecency)[0];
  }

  return null;
}
