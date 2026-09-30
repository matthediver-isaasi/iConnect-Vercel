import assert from "node:assert/strict";
import test from "node:test";
import {
  filterEventsByInternalType,
  normalizeInternalEventTypeFilter,
} from "./event-budget-report.js";

const events = [
  { id: "simple-1", internal_event_type: "Conference" },
  { id: "complex-1", internal_event_type: "Training" },
  { id: "simple-2", internal_event_type: "Webinar" },
  { id: "simple-3", internal_event_type: null },
];

test("normalizes repeated and comma-separated internal event type values", () => {
  assert.deepEqual(
    normalizeInternalEventTypeFilter([" Conference ", "Training,Webinar", "Conference", 42]),
    ["Conference", "Training", "Webinar"],
  );
});

test("matches any selected internal type across event kinds", () => {
  assert.deepEqual(
    filterEventsByInternalType(events, ["Conference", "Training"]).map((event) => event.id),
    ["simple-1", "complex-1"],
  );
});

test("empty selection preserves all events", () => {
  assert.equal(filterEventsByInternalType(events, []), events);
});

test("non-matching values return no events", () => {
  assert.deepEqual(filterEventsByInternalType(events, ["Awards"]), []);
});