/**
 * Ticket releases are absolute instants. The saved timezone is presentation
 * metadata, never inherited from an event after a schedule has been saved.
 */
export function isTicketReleaseTimezone(value) {
  if (typeof value !== 'string' || (value !== 'UTC' && !value.includes('/'))) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function validateTicketRelease(ticket = {}) {
  const at = ticket?.release_at;
  const timezone = ticket?.release_timezone;
  if (at == null && timezone == null) return null;
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(at)
    || !Number.isFinite(Date.parse(at))) {
    return 'Ticket release must include a valid date and time with an explicit timezone offset.';
  }
  // Date.parse normalizes impossible calendar dates such as February 30.
  const [year, month, day] = at.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || Number(at.slice(11, 13)) > 23 || Number(at.slice(14, 16)) > 59) {
    return 'Ticket release date and time is invalid.';
  }
  if (!isTicketReleaseTimezone(timezone)) {
    return 'Ticket release must include a valid IANA timezone.';
  }
  return null;
}

/** Equality is released. Malformed persisted schedules fail closed. */
export function isTicketReleased(ticket, nowMs = Date.now()) {
  if (ticket?.release_at == null && ticket?.release_timezone == null) return true;
  if (validateTicketRelease(ticket)) return false;
  return Number.isFinite(Number(nowMs)) && Date.parse(ticket.release_at) <= Number(nowMs);
}

export function ticketReleaseMessage(ticket) {
  if (validateTicketRelease(ticket) || !ticket?.release_at) {
    return 'This ticket is not available yet. Please contact the event organiser.';
  }
  const instant = new Date(ticket.release_at);
  const timeZone = ticket.release_timezone;
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone, day: 'numeric', month: 'long', year: 'numeric',
  }).format(instant);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(instant);
  return `Tickets available from ${date} at ${time} (${timeZone})`;
}