import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatInTimeZone } from "date-fns-tz";
import { parseISO } from "date-fns";
import { latestSessionStart } from "./sessionStartDefault.mjs";

// Execute the actual editor initialization handlers without mounting unrelated
// event integrations or contacting a tenant database.
const source = readFileSync(new URL("../pages/CreateComplexEvent.jsx", import.meta.url), "utf8");
const conversion = source.slice(source.indexOf("  const toLocalDatetimeStr ="), source.indexOf("  const computeEndTimeFromDuration ="));
const opening = source.slice(source.indexOf("  const openSessionDialog ="), source.indexOf("  const closeSessionDialog ="));
function editor(sessions, timezone = "Europe/London") {
  const state = {};
  const open = new Function("sessions", "formData", "DEFAULT_TIMEZONE", "formatInTimeZone", "parseISO",
    "latestSessionStart", "setSessionDialogOpen", "setEditingSession", "setSessionForm",
    "setSessionDuration", "normalizeAttendancePolicy", "detectDurationFromTimes",
    `${conversion}\n${opening}\nreturn openSessionDialog;`
  )(sessions, { timezone }, "Europe/London", formatInTimeZone, parseISO, latestSessionStart,
    v => state.open = v, v => state.editing = v, v => state.form = v,
    v => state.duration = v, () => ({}), () => "60");
  return { state, open };
}

test("latest scheduled start across tracks wins, not display order or end date", () => {
  const { state, open } = editor([
    { start_time: "2028-08-12T15:30", track_ids: ["b"] },
    { start_time: "2028-08-10T11:00", end_time: "2028-08-20T12:00", track_ids: ["a"] },
    { start_time: "2028-08-12T09:00", track_ids: ["a", "b"] },
  ]);
  open();
  assert.equal(state.form.start_time, "2028-08-12T15:30");
  assert.equal(state.form.end_time, "");
  assert.equal(state.duration, "custom");
  assert.deepEqual(state.form.track_ids, []);
});

test("empty, missing and invalid dates leave first-session behavior unchanged", () => {
  for (const sessions of [[], [{}, { start_time: null }, { start_time: "" },
    { start_time: "invalid" }, { start_time: "2028-02-30T10:00" }, { start_time: "2028-13-01T12:00" }]]) {
    const { state, open } = editor(sessions);
    open();
    assert.equal(state.form.start_time, "");
  }
});

test("unsaved additions and removals recalculate only when opened", () => {
  const sessions = [{ start_time: "2028-08-12T15:30" }];
  const { state, open } = editor(sessions);
  open();
  state.form.start_time = "2028-09-01T10:00";
  sessions.push({ _localId: "unsaved", start_time: "2028-10-02T14:00" });
  assert.equal(state.form.start_time, "2028-09-01T10:00");
  open();
  assert.equal(state.form.start_time, "2028-10-02T14:00");
  sessions.pop();
  open();
  assert.equal(state.form.start_time, "2028-08-12T15:30");
  sessions.pop();
  open();
  assert.equal(state.form.start_time, "");
});

test("grid prefills including explicit empty starts retain priority and tracks", () => {
  const { state, open } = editor([{ start_time: "2028-08-12T15:30" }]);
  for (const start_time of ["2028-07-01T09:00", ""]) {
    open(null, { start_time, track_ids: ["a"] });
    assert.equal(state.form.start_time, start_time);
    assert.deepEqual(state.form.track_ids, ["a"]);
  }
});

test("editing retains its own dates and duration", () => {
  const { state, open } = editor([{ start_time: "2028-08-12T15:30" }]);
  open({ _localId: "editing", start_time: "2028-01-01T09:00", end_time: "2028-01-01T10:00", track_ids: ["a"] });
  assert.equal(state.editing, "editing");
  assert.equal(state.form.start_time, "2028-01-01T09:00");
  assert.equal(state.form.end_time, "2028-01-01T10:00");
  assert.equal(state.duration, "60");
});

test("offset timestamps use existing event timezone conversion; local values never shift", () => {
  const { state, open } = editor([
    { start_time: "2028-08-12T23:30:00Z" },
    { start_time: "2028-08-13T00:15" },
  ]);
  open();
  assert.equal(state.form.start_time, "2028-08-13T00:30");
});
