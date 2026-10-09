import {
  addDays, addMonths, addWeeks, differenceInCalendarDays, eachDayOfInterval,
  endOfMonth, endOfWeek, format, isBefore, isSameDay, isValid, parseISO,
  startOfDay, startOfMonth, startOfWeek,
} from "date-fns";

/** Persisted dates describe local calendar days, including ISO timestamp fields. */
export function readCalendarDate(value) {
  if (!value) return null;
  const date = typeof value === "string"
    ? parseISO(/^\d{4}-\d{2}-\d{2}(?:T|\s|$)/.test(value) ? value.slice(0, 10) : value)
    : new Date(value);
  return isValid(date) ? startOfDay(date) : null;
}

export function cardDateRange(card) {
  const start = readCalendarDate(card.start_date);
  const due = readCalendarDate(card.due_date);
  if (!start && !due) return null;
  const first = start || due;
  const last = due || start;
  // A malformed reversed range is still surfaced instead of disappearing.
  return isBefore(last, first) ? { start: last, end: first } : { start: first, end: last };
}

export function isCardOverdue(card, today = new Date()) {
  const due = readCalendarDate(card.due_date);
  return Boolean(!card.is_complete && due && isBefore(due, startOfDay(today)));
}

export function cardsOnDate(cards, date) {
  const day = startOfDay(date);
  return cards.filter(card => {
    const range = cardDateRange(card);
    return range && !isBefore(day, range.start) && !isBefore(range.end, day);
  });
}

export function navigateCalendar(date, mode, direction) {
  return mode === "month" ? addMonths(date, direction)
    : mode === "week" ? addWeeks(date, direction) : addDays(date, direction);
}

export function calendarWeeks(date, mode) {
  const start = startOfWeek(mode === "month" ? startOfMonth(date) : date, { weekStartsOn: 1 });
  const end = endOfWeek(mode === "month" ? endOfMonth(date) : date, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start, end });
  return Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7));
}

/** Assign non-overlapping lanes to inclusive spans, clipped at each week's edges. */
export function weekCardSpans(cards, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const spans = cards.flatMap(card => {
    const range = cardDateRange(card);
    if (!range || isBefore(range.end, weekStart) || isBefore(weekEnd, range.start)) return [];
    const start = isBefore(range.start, weekStart) ? weekStart : range.start;
    const end = isBefore(weekEnd, range.end) ? weekEnd : range.end;
    return [{
      card, startColumn: differenceInCalendarDays(start, weekStart) + 1,
      endColumn: differenceInCalendarDays(end, weekStart) + 1,
      continuesBefore: isBefore(range.start, weekStart), continuesAfter: isBefore(weekEnd, range.end),
    }];
  }).sort((a, b) => a.startColumn - b.startColumn || b.endColumn - a.endColumn || String(a.card.title).localeCompare(String(b.card.title)));
  const laneEnds = [];
  return spans.map(span => {
    let lane = laneEnds.findIndex(end => end < span.startColumn);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = span.endColumn;
    return { ...span, lane };
  });
}

export function calendarHeading(date, mode) {
  if (mode === "day") return format(date, "EEEE, d MMMM yyyy");
  if (mode === "month") return format(date, "MMMM yyyy");
  const [week] = calendarWeeks(date, "week");
  return `${format(week[0], "d MMM yyyy")} – ${format(week[6], "d MMM yyyy")}`;
}

export function sameCalendarDay(a, b) { return isSameDay(a, b); }
