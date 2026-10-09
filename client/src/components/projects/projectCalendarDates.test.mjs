import test from "node:test";
import assert from "node:assert/strict";
import { format } from "date-fns";
import {
  readCalendarDate, cardDateRange, cardsOnDate, calendarWeeks,
  navigateCalendar, weekCardSpans, isCardOverdue,
} from "./projectCalendarDates.js";

const date = readCalendarDate;
const key = value => format(value, "yyyy-MM-dd");
test("date-only and timestamp fields preserve their written local day", () => {
  for (const input of ["2026-10-09", "2026-10-09T00:00:00Z", "2026-10-09T23:59:00-11:00"]) {
    assert.equal(key(date(input)), "2026-10-09");
    assert.equal(date(input).getHours(), 0);
  }
  for (const input of [null, "", "bad", "2026-02-30"]) assert.equal(date(input), null);
});

test("inclusive ranges, single endpoints and undated/invalid cards", () => {
  const cards = [
    { id: "range", start_date: "2026-10-06", due_date: "2026-10-08" },
    { id: "start", start_date: "2026-10-08" },
    { id: "due", due_date: "2026-10-08" },
    { id: "none" }, { id: "invalid", due_date: "bad" },
  ];
  assert.deepEqual(cardsOnDate(cards, date("2026-10-06")).map(c => c.id), ["range"]);
  assert.deepEqual(cardsOnDate(cards, date("2026-10-08")).map(c => c.id), ["range", "start", "due"]);
  assert.equal(cardsOnDate(cards, date("2026-10-09")).length, 0);
  assert.equal(cardDateRange(cards[3]), null);
  assert.equal(cardDateRange(cards[4]), null);
  assert.equal(key(cardDateRange({ start_date: "2026-10-08", due_date: "2026-10-06" }).start), "2026-10-06");
});

test("navigation clamps month ends and crosses year/week/day boundaries", () => {
  assert.equal(key(navigateCalendar(date("2026-01-31"), "month", 1)), "2026-02-28");
  assert.equal(key(navigateCalendar(date("2024-01-31"), "month", 1)), "2024-02-29");
  assert.equal(key(navigateCalendar(date("2026-12-31"), "day", 1)), "2027-01-01");
  assert.equal(key(navigateCalendar(date("2026-12-28"), "week", 1)), "2027-01-04");
  assert.equal(key(navigateCalendar(date("2026-01-15"), "month", -1)), "2025-12-15");
});

test("month and week use Monday-first full weeks including adjacent months", () => {
  const weeks = calendarWeeks(date("2026-10-09"), "month");
  assert.equal(key(weeks[0][0]), "2026-09-28");
  assert.equal(key(weeks.at(-1)[6]), "2026-11-01");
  assert.equal(weeks.length, 5);
  assert.deepEqual(calendarWeeks(date("2026-10-09"), "week")[0].map(key),
    ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
});

test("multi-day bars clip to week boundaries, include endpoints and never overlap in a lane", () => {
  const cards = [
    { id: "long", title: "Long", start_date: "2026-10-01", due_date: "2026-10-14" },
    { id: "middle", title: "Middle", start_date: "2026-10-06", due_date: "2026-10-08" },
    { id: "same-end", title: "Same end", due_date: "2026-10-08" },
    { id: "after", title: "After", due_date: "2026-10-09" },
    { id: "outside", title: "Outside", due_date: "2026-10-20" },
  ];
  const spans = weekCardSpans(cards, date("2026-10-05"));
  const long = spans.find(s => s.card.id === "long");
  assert.deepEqual([long.startColumn, long.endColumn, long.continuesBefore, long.continuesAfter], [1, 7, true, true]);
  assert.equal(spans.length, 4);
  for (const first of spans) for (const second of spans) {
    if (first !== second && first.lane === second.lane) assert.ok(first.endColumn < second.startColumn || second.endColumn < first.startColumn);
  }
  const next = weekCardSpans([cards[0]], date("2026-10-12"))[0];
  assert.deepEqual([next.startColumn, next.endColumn, next.continuesBefore, next.continuesAfter], [1, 3, true, false]);
  const crowded = Array.from({ length: 64 }, (_, index) => ({ id: index, title: `Task ${index}`, due_date: "2026-10-08" }));
  assert.equal(weekCardSpans(crowded, date("2026-10-05")).length, 64);
});

test("overdue is based on local due day and excludes completed/today/start-only", () => {
  const today = date("2026-10-09");
  assert.equal(isCardOverdue({ due_date: "2026-10-08" }, today), true);
  assert.equal(isCardOverdue({ due_date: "2026-10-09" }, today), false);
  assert.equal(isCardOverdue({ due_date: "2026-10-08", is_complete: true }, today), false);
  assert.equal(isCardOverdue({ start_date: "2026-10-08" }, today), false);
});
