// Task #3266: helpers for complex events whose session days are
// non-consecutive (e.g. a 2-week span with only a few actual event days).
// Day grouping matches the schedule grid: sessions are bucketed by their
// calendar day in the event's timezone.
import { parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

const DEFAULT_TIMEZONE = "Europe/London";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getSessionDayKeys(sessions, timezone = DEFAULT_TIMEZONE) {
  const keys = new Set();
  (sessions || []).forEach((s) => {
    if (!s?.start_time) return;
    try {
      keys.add(formatInTimeZone(parseISO(s.start_time), timezone || DEFAULT_TIMEZONE, "yyyy-MM-dd"));
    } catch {
      // ignore unparseable session times
    }
  });
  return [...keys].sort();
}

// dayKeys: sorted array of 'yyyy-MM-dd' strings.
export function computeDayInfoFromKeys(dayKeys) {
  const dayCount = dayKeys.length;
  if (dayCount <= 1) return { dayCount, isNonConsecutive: false };
  const spanDays = Math.round(
    (Date.parse(`${dayKeys[dayCount - 1]}T00:00:00Z`) - Date.parse(`${dayKeys[0]}T00:00:00Z`)) / MS_PER_DAY
  ) + 1;
  return { dayCount, isNonConsecutive: spanDays > dayCount };
}

export function computeComplexEventDayInfo(sessions, timezone = DEFAULT_TIMEZONE) {
  return computeDayInfoFromKeys(getSessionDayKeys(sessions, timezone));
}
