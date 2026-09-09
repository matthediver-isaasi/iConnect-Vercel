import assert from "node:assert/strict";
import test from "node:test";
import {
  eventCpdConfigToPayload,
  normalizeEventCpdBadgeConfig,
  remapEventCpdTicketReferences,
  ticketStableReference,
  attendanceCapabilityWarnings,
  canonicalEventCpdBadgeConfig,
} from "./eventCpdBadgeRules.js";

test("normalizes event, ticket, and explicit no-award rules", () => {
  const value = normalizeEventCpdBadgeConfig([
    { scope: "event", badge_id: "b1", trigger: "registration" },
    { scope: "ticket", ticket_reference: "local-1", trigger: "attendance", is_no_award: true },
  ]);
  assert.equal(value.eventRule.badge_id, "b1");
  assert.equal(value.ticketRules["local-1"].no_award, true);
});

test("payload drops overrides for tickets that were removed", () => {
  const payload = eventCpdConfigToPayload({
    eventRule: null,
    ticketRules: {
      keep: { badge_id: "b1", trigger: "attendance" },
      removed: { no_award: true, trigger: "registration" },
    },
  }, [{ id: "keep", name: "Member" }]);
  assert.equal(payload.rules.length, 1);
  assert.equal(payload.rules[0].ticket_reference, "keep");
});

test("new complex ticket references remap to persisted ids", () => {
  const config = { eventRule: null, ticketRules: { tmp1: { no_award: true, trigger: "registration" } } };
  const remapped = remapEventCpdTicketReferences(config, { tmp1: "db1" });
  assert.equal(remapped.ticketRules.db1.no_award, true);
  assert.equal(config.ticketRules.tmp1.no_award, true);
  assert.equal(remapped.ticketRules.tmp1, undefined);
  assert.equal(ticketStableReference({ _dbId: "db1", _localId: "tmp1" }), "db1");
  assert.deepEqual(
    eventCpdConfigToPayload(remapped, [{ _localId: "tmp1", _dbId: "db1", name: "New ticket" }]).rules,
    [{
      scope: "ticket",
      ticket_reference: "db1",
      ticket_class_id: "db1",
      ticket_name_snapshot: "New ticket",
      badge_id: null,
      trigger: "registration",
      no_award: true,
    }],
  );
});

test("uses only server-supplied non-empty attendance capability warnings", () => {
  assert.deepEqual(
    attendanceCapabilityWarnings({ warnings: ["Teams final attendance is unavailable", "", null] }),
    ["Teams final attendance is unavailable"],
  );
  assert.deepEqual(attendanceCapabilityWarnings(null), []);
});

test("aggregates nested QR, Zoom and Teams capability warnings", () => {
  assert.deepEqual(
    attendanceCapabilityWarnings({
      qr: { available: false, warning: "QR check-in evidence is unavailable" },
      zoom: { available: false, warnings: ["Zoom attendance evidence is unavailable"] },
      teams: { available: false, warning: "Teams attendance evidence is unavailable" },
    }),
    [
      "QR check-in evidence is unavailable",
      "Zoom attendance evidence is unavailable",
      "Teams attendance evidence is unavailable",
    ],
  );
});

test("saved-rule comparison ignores snapshots and ordering but detects semantic edits", () => {
  const saved = normalizeEventCpdBadgeConfig([
    { scope: "ticket", ticket_reference: "ticket-2", badge_id: "b2", trigger: "attendance", ticket_name_snapshot: "Old name" },
    { scope: "event", badge_id: "b1", trigger: "registration", badge_name_snapshot: "Badge one" },
    { scope: "ticket", ticket_reference: "ticket-1", badge_id: null, trigger: "registration", no_award: true },
  ]);
  const unchangedEditor = {
    eventRule: { badge_id: "b1", trigger: "registration", no_award: false },
    ticketRules: {
      "ticket-1": { no_award: true, trigger: "registration" },
      "ticket-2": { badge_id: "b2", trigger: "attendance", ticket_name_snapshot: "Renamed" },
    },
  };
  assert.equal(canonicalEventCpdBadgeConfig(saved), canonicalEventCpdBadgeConfig(unchangedEditor));
  assert.notEqual(
    canonicalEventCpdBadgeConfig(saved),
    canonicalEventCpdBadgeConfig({ ...unchangedEditor, eventRule: { badge_id: "b1", trigger: "attendance" } }),
  );
  assert.notEqual(
    canonicalEventCpdBadgeConfig(saved),
    canonicalEventCpdBadgeConfig({ ...unchangedEditor, ticketRules: {} }),
  );
});
