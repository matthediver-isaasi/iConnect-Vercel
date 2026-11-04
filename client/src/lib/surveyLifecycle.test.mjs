import test from "node:test";
import assert from "node:assert/strict";
import { surveyLifecycleState, surveyAvailability, assignmentIsRemoved, publicSurveyUnavailableMessage } from "./surveyLifecycle.js";

const form = { id: "survey", form_type: "survey", is_active: true, survey_settings: { status: "published", current_version: 3 } };
const assignment = { id: "assignment", status: "attached", event_id: "event", access_mode: "authenticated" };

test("authoritative lifecycle overrides legacy flags and conservative fallback preserves disabled surveys", () => {
  assert.equal(surveyLifecycleState({ ...form, is_active: false, archived_at: "date", survey_settings: { lifecycle_state: "closed" } }), "archived");
  assert.equal(surveyLifecycleState({ ...form, is_active: false }), "paused");
  assert.equal(surveyLifecycleState({ ...form, archived_at: "date" }), "archived");
  assert.equal(surveyLifecycleState(form), "active");
  assert.equal(surveyLifecycleState({ survey_settings: { status: "draft" } }), "draft");
  assert.equal(surveyLifecycleState({ survey_settings: { status: "archived" } }), "archived");
  assert.equal(surveyLifecycleState({ is_active: false, survey_settings: { status: "archived" } }), "archived");
});

test("draft edits do not change active published link availability", () => {
  const edited = { ...form, survey_settings: { current_version: 3, status: "draft", lifecycle_state: "active", has_unpublished_changes: true } };
  assert.equal(surveyAvailability(edited, assignment).available, true);
});

test("attachment is independent from effective availability and removed legacy relationships remain visible", () => {
  for (const status of ["removed", "archived"]) {
    assert.equal(assignmentIsRemoved({ status }), true);
    assert.equal(surveyAvailability(form, { ...assignment, status }).label, "Removed from event");
  }
  for (const state of ["paused", "closed", "archived", "draft"]) {
    assert.equal(surveyAvailability({ ...form, survey_settings: { ...form.survey_settings, lifecycle_state: state } }, assignment).available, false);
  }
  assert.equal(surveyAvailability(form, assignment).available, true);
  assert.match(surveyAvailability(form, assignment).reason, /signed-in members/);
});

test("restoring or reattaching does not override original expiry, publication or event validity", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  assert.equal(surveyAvailability(form, { ...assignment, closes_at: "2026-10-22T12:00:00Z" }, now).available, false);
  assert.equal(surveyAvailability(form, { ...assignment, opens_at: "2026-10-23T12:00:00Z" }, now).label, "Not open yet");
  assert.equal(surveyAvailability(form, { ...assignment, event_id: null }, now).label, "Event unavailable");
  assert.equal(surveyAvailability({ ...form, survey_settings: { lifecycle_state: "active" } }, assignment).label, "No published version");
  assert.equal(surveyAvailability(null, assignment).available, false);
});

test("public messages disclose states only, never server errors or protected metadata", () => {
  assert.match(publicSurveyUnavailableMessage("paused"), /temporarily unavailable/);
  assert.match(publicSurveyUnavailableMessage("closed"), /now closed/);
  assert.match(publicSurveyUnavailableMessage("archived"), /no longer available/);
  assert.match(publicSurveyUnavailableMessage("removed"), /this event/);
  assert.doesNotMatch(publicSurveyUnavailableMessage("<protected survey name>"), /protected survey/);
});
