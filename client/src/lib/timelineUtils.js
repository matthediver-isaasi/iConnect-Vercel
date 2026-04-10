import { parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

const DEFAULT_PIXELS_PER_MINUTE = 2;
const DEFAULT_MIN_CARD_HEIGHT = 40;
const DEFAULT_MARKER_INTERVAL = 30;
const DEFAULT_TIMEZONE = "Europe/London";
const DEFAULT_FALLBACK_DURATION = 30;

function toDate(dateStr) {
  if (!dateStr) return null;
  return typeof dateStr === "string" ? parseISO(dateStr) : new Date(dateStr);
}

export function computeTimelineLayout(sessions, {
  pixelsPerMinute = DEFAULT_PIXELS_PER_MINUTE,
  minCardHeight = DEFAULT_MIN_CARD_HEIGHT,
  markerInterval = DEFAULT_MARKER_INTERVAL,
  timezone = DEFAULT_TIMEZONE,
  fallbackDuration = DEFAULT_FALLBACK_DURATION,
} = {}) {
  const withStartTime = sessions.filter(s => s.start_time);
  if (withStartTime.length === 0) {
    return { totalHeight: 0, sessionLayouts: {}, timeMarkers: [], startMinutes: 0, endMinutes: 0 };
  }

  function getEffectiveEnd(s) {
    if (s.end_time) return toDate(s.end_time).getTime();
    const dur = s.duration_minutes || fallbackDuration;
    return toDate(s.start_time).getTime() + dur * 60000;
  }

  let earliestMs = Infinity;
  let latestMs = -Infinity;

  withStartTime.forEach(s => {
    const start = toDate(s.start_time).getTime();
    const end = getEffectiveEnd(s);
    if (start < earliestMs) earliestMs = start;
    if (end > latestMs) latestMs = end;
  });

  const earliestDate = new Date(earliestMs);
  const earliestMinOfHour = earliestDate.getMinutes();
  const snapOffsetMs = (earliestMinOfHour % markerInterval) * 60000;
  const snappedEarliestMs = earliestMs - snapOffsetMs;

  const getMinutesFromOrigin = (ms) => {
    return (ms - snappedEarliestMs) / 60000;
  };

  const totalMinutes = (latestMs - snappedEarliestMs) / 60000;

  const sessionLayouts = {};
  let maxBottom = 0;
  withStartTime.forEach(s => {
    const id = s.id || s._localId;
    const startMs = toDate(s.start_time).getTime();
    const endMs = getEffectiveEnd(s);
    const startMin = getMinutesFromOrigin(startMs);
    const endMin = getMinutesFromOrigin(endMs);
    const durationMin = endMin - startMin;
    const rawHeight = durationMin * pixelsPerMinute;
    const height = Math.max(rawHeight, minCardHeight);
    const top = startMin * pixelsPerMinute;
    const bottom = top + height;
    if (bottom > maxBottom) maxBottom = bottom;

    sessionLayouts[id] = { top, height, durationMinutes: durationMin, isCompressed: rawHeight < minCardHeight };
  });

  const totalHeight = Math.max(maxBottom, totalMinutes * pixelsPerMinute, 100);

  const timeMarkers = [];
  for (let min = 0; min <= totalMinutes; min += markerInterval) {
    const markerDate = new Date(snappedEarliestMs + min * 60000);
    let label;
    try {
      label = formatInTimeZone(markerDate, timezone, "h:mm a");
    } catch {
      label = markerDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    timeMarkers.push({
      top: min * pixelsPerMinute,
      label,
      minutes: min,
    });
  }

  return {
    totalHeight,
    sessionLayouts,
    timeMarkers,
    startMinutes: 0,
    endMinutes: totalMinutes,
  };
}
