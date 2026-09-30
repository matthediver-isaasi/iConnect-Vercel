import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventBudgetReportParams,
  clearEventBudgetReportFilters,
} from "./eventBudgetReportFilters.js";

test("buildEventBudgetReportParams wires multiple internal event types", () => {
  const params = buildEventBudgetReportParams({
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    internalEventTypes: ["Conference", "Training"],
  });

  assert.equal(params.get("eventDateFrom"), "2026-01-01");
  assert.equal(params.get("eventDateTo"), "2026-12-31");
  assert.deepEqual(params.getAll("internalEventType"), ["Conference", "Training"]);
});

test("buildEventBudgetReportParams omits an empty internal event type selection", () => {
  const params = buildEventBudgetReportParams({ internalEventTypes: [] });
  assert.equal(params.has("internalEventType"), false);
});

test("clearEventBudgetReportFilters resets dates and internal event types", () => {
  assert.deepEqual(clearEventBudgetReportFilters(), {
    dateFrom: "",
    dateTo: "",
    internalEventTypes: [],
  });
});