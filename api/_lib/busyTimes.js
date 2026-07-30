import { fromZonedTime } from 'date-fns-tz';

// Matches an explicit UTC designator or numeric offset at the END of an ISO
// datetime string (e.g. "...Z", "...+01:00", "...-0500"). A bare ISO date like
// "2026-02-10T10:00:00" contains hyphens but has NO offset, so we must anchor
// to the end of the string rather than using includes('-').
const EXPLICIT_OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a Microsoft Graph calendar time into a UTC Date.
 *
 * Graph returns event times WITHOUT an offset, expressed in the timezone we
 * requested via the `Prefer: outlook.timezone` header. Only strings that carry
 * an explicit `Z` or numeric offset are treated as absolute; everything else
 * is converted from the supplied IANA timezone to UTC.
 *
 * @param {string} timeStr ISO datetime, with or without an explicit offset
 * @param {string} timeZone IANA timezone the naive string is expressed in
 * @param {string} [fallbackTimeZone] used when timeZone is not a valid IANA
 *   name (Graph can return Windows names like "GMT Standard Time")
 * @returns {Date} UTC instant
 */
export function parseBusyTimeToUTC(timeStr, timeZone, fallbackTimeZone = 'UTC') {
  if (EXPLICIT_OFFSET_RE.test(timeStr)) {
    return new Date(timeStr);
  }
  let result = fromZonedTime(timeStr, timeZone);
  if (isNaN(result.getTime()) && fallbackTimeZone && fallbackTimeZone !== timeZone) {
    // timeZone was not a valid IANA name (e.g. a Windows timezone id)
    result = fromZonedTime(timeStr, fallbackTimeZone);
  }
  if (isNaN(result.getTime())) {
    // Last resort: treat as UTC so we still block the slot rather than skip it
    result = new Date(`${timeStr}Z`);
  }
  return result;
}

/**
 * Whether a [slotStart, slotEnd) window overlaps any busy time.
 *
 * @param {Date} slotStart UTC
 * @param {Date} slotEnd UTC
 * @param {Array<{start: string, end: string, timeZone?: string}>} busyTimes
 * @param {string} agentTimezone fallback timezone for naive busy strings
 * @returns {boolean}
 */
export function slotConflictsWithBusyTimes(slotStart, slotEnd, busyTimes, agentTimezone) {
  return (busyTimes || []).some(busy => {
    const busyStart = parseBusyTimeToUTC(busy.start, busy.timeZone || agentTimezone, agentTimezone);
    const busyEnd = parseBusyTimeToUTC(busy.end, busy.timeZone || agentTimezone, agentTimezone);
    return slotStart < busyEnd && slotEnd > busyStart;
  });
}
