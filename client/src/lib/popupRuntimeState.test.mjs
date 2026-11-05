import test from "node:test";
import assert from "node:assert/strict";
import { frequencyAllows, mergePopupPreferenceState, popupHistoryView, popupStorageKey, rankPopupCandidates, triggerReady } from "./popupRuntimeState.js";
import { tenantDateTime, tenantDateTimeToUtc } from "./popupSchedule.js";

test("trigger-ready lower priority popup is not blocked by a delayed candidate", () => {
  const candidates = [
    { id: "a", config: { priority: 91, trigger: { type: "delay", value: 15 } } },
    { id: "b", config: { priority: 7, trigger: { type: "immediate" } } },
  ];
  assert.equal(rankPopupCandidates(candidates.filter((p) => triggerReady(p.config.trigger, 900, 0, 1800, 800)))[0].id, "b");
  assert.equal(triggerReady({ type: "scroll_percent", value: 37 }, 0, 370, 1800, 800), true);
  assert.equal(triggerReady({ type: "scroll_pixels", value: 371 }, 0, 370, 1800, 800), false);
  assert.equal(triggerReady({ type: "delay", value: -1 }, 9999, 0, 1, 1), false);
});
test("priority ties use stable ID", () => {
  assert.deepEqual(rankPopupCandidates([{ id: "z" }, { id: "b" }, { id: "a" }]).map((p) => p.id), ["a", "b", "z"]);
});
test("query changes and history restoration share the consumed allowance", () => {
  const original = popupHistoryView("history-a", "/popup-test-a");
  original.consumed.add("tenant|viewer");
  assert.equal(popupHistoryView("history-a-query", "/popup-test-a"), original);
  const second = popupHistoryView("history-b", "/popup-test-b");
  assert.notEqual(second, original);
  assert.equal(popupHistoryView("history-a", "/popup-test-a").consumed.has("tenant|viewer"), true);
  popupHistoryView("history-b", "/popup-test-b");
  assert.notEqual(popupHistoryView("history-new-a", "/popup-test-a"), original);
});
test("frequency uses tenant calendar days and elapsed N days", () => {
  const now = Date.parse("2026-08-13T00:30:00Z");
  assert.equal(frequencyAllows({ type: "day" }, "2026-08-12T23:30:00Z", now, "America/New_York"), false);
  assert.equal(frequencyAllows({ type: "day" }, "2026-08-12T23:30:00Z", now, "UTC"), true);
  assert.equal(frequencyAllows({ type: "n_days", days: 2 }, new Date(now - 47 * 3600000).toISOString(), now), false);
  assert.equal(frequencyAllows({ type: "n_days", days: 2 }, new Date(now - 49 * 3600000).toISOString(), now), true);
});
test("storage isolates tenant, authenticated identity and dismissal generation", () => {
  const popup = { id: "p", dismissal_generation: 4 };
  const key = popupStorageKey("tenant-a", "member-a", popup);
  assert.notEqual(key, popupStorageKey("tenant-b", "member-a", popup));
  assert.notEqual(key, popupStorageKey("tenant-a", "member-b", popup));
  assert.notEqual(key, popupStorageKey("tenant-a", "member-a", { ...popup, dismissal_generation: 5 }));
});
test("permanent state is monotonic across all layers; session state never comes from disk", () => {
  assert.equal(mergePopupPreferenceState({ permanent: true }, { permanent: false }, { permanent: false }).permanent, true);
  assert.equal(mergePopupPreferenceState({ permanent: false }, { permanent: true }, { permanent: false }).permanent, true);
  assert.equal(mergePopupPreferenceState({ permanent: false }, { permanent: false }, { permanent: true }).permanent, true);
  const state = mergePopupPreferenceState({ last: "2026-11-01T12:30:00Z", session: true }, null, null);
  assert.equal(state.session, false);
  assert.equal(state.sessionLast, null);
  assert.equal(state.last, "2026-11-01T12:30:00Z");
});
test("tenant schedules reject DST gaps and ambiguity, without browser timezone shifts", () => {
  assert.equal(tenantDateTimeToUtc("2026-07-12T09:30", "Europe/London"), "2026-07-12T08:30:00.000Z");
  assert.equal(tenantDateTime("2026-07-12T08:30:00.000Z", "Europe/London"), "2026-07-12T09:30");
  assert.throws(() => tenantDateTimeToUtc("2026-03-08T02:30", "America/New_York"), /does not exist/);
  assert.throws(() => tenantDateTimeToUtc("2026-11-01T01:30", "America/New_York"), /occurs twice/);
});
