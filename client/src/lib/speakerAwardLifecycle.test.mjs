import test from "node:test";
import assert from "node:assert/strict";
import {
  finalRemovedSpeakerIds,
  hasRelevantAwardedBadge,
  speakerIdsFromReferences,
} from "./speakerAwardLifecycle.js";

test("speaker reference helpers de-duplicate event, agenda and session speakers", () => {
  assert.deepEqual(speakerIdsFromReferences({
    eventSpeakerIds: ["one"],
    agendaLines: [{ speaker_ids: ["one", "two"] }],
    sessions: [{ speaker_ids: ["three"] }],
  }).sort(), ["one", "three", "two"]);
});

test("only speakers with their final event reference removed are returned", () => {
  assert.deepEqual(finalRemovedSpeakerIds(
    { eventSpeakerIds: ["one"], agendaLines: [{ speaker_ids: ["two"] }], sessions: [{ speaker_ids: ["three"] }] },
    { eventSpeakerIds: [], agendaLines: [{ speaker_ids: ["two"] }], sessions: [] },
  ).sort(), ["one", "three"]);
});

test("removing a duplicate reference does not report a final removal", () => {
  assert.deepEqual(finalRemovedSpeakerIds(
    { eventSpeakerIds: ["one"], agendaLines: [{ speaker_ids: ["one"] }] },
    { eventSpeakerIds: ["one"], agendaLines: [] },
  ), []);
});

test("badge confirmation follows active persisted grants even if future awards were disabled or changed", () => {
  const config = { enabled: true, default: { badge_id: "badge-a" }, overrides: {} };
  assert.equal(hasRelevantAwardedBadge(null, [{ speaker_id: "one", member_badge_id: "member-badge", member_badge_active: true }], ["one"]), true);
  assert.equal(hasRelevantAwardedBadge(config, [], ["one"]), false);
  assert.equal(hasRelevantAwardedBadge(config, [{ speaker_id: "other", member_badge_id: "member-badge", member_badge_active: true }], ["one"]), false);
  assert.equal(hasRelevantAwardedBadge(config, [{ speaker_id: "one" }], ["one"]), false);
  assert.equal(hasRelevantAwardedBadge(config, [{ speaker_id: "one", member_badge_id: "member-badge", member_badge_active: true }], ["one"]), true);
  assert.equal(hasRelevantAwardedBadge({ ...config, enabled: false }, [{ speaker_id: "one", member_badge_id: "x", member_badge_active: true, badge_id: "old-badge" }], ["one"]), true);
  assert.equal(hasRelevantAwardedBadge(config, [{ speaker_id: "one", member_badge_id: "x", member_badge_active: false }], ["one"]), false);
});