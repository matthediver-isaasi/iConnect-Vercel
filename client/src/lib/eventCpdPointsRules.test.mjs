import assert from "node:assert/strict";
import test from "node:test";
import {
  eventCpdPointsConfigToPayload,
  normalizeCpdPoints,
  normalizeEventCpdPointsConfig,
  remapEventCpdPointsTicketReferences,
  validateEventCpdPointsConfig,
} from "./eventCpdPointsRules.js";

test("accepts non-negative plain decimals without floating-point conversion", () => {
  assert.equal(normalizeCpdPoints("99999999999999.5000"), "99999999999999.5");
  assert.equal(normalizeCpdPoints("0"), "0");
  assert.equal(normalizeCpdPoints("-1"), null);
  assert.equal(normalizeCpdPoints("1e3"), null);
  assert.equal(normalizeCpdPoints("100000000000000"), null);
  assert.equal(normalizeCpdPoints("1.1234567"), null);
});

test("normalizes loaded event and ticket rules including explicit no-award", () => {
  const config = normalizeEventCpdPointsConfig([
    { scope: "event", points: "2.50", trigger: "registration" },
    { scope: "ticket", ticket_class_id: "t1", no_award: true, trigger: "attendance" },
  ]);
  assert.equal(config.eventRule.points, "2.5");
  assert.equal(config.ticketRules.t1.no_award, true);
});

test("payload preserves zero and makes ticket precedence explicit", () => {
  const payload = eventCpdPointsConfigToPayload({
    eventRule: { points: "2.25", trigger: "registration" },
    ticketRules: {
      t1: { points: "0", trigger: "attendance", no_award: false },
      t2: { points: null, trigger: "registration", no_award: true },
    },
  }, [{ _dbId: "t1", name: "Member" }, { _dbId: "t2", name: "Guest" }]);
  assert.deepEqual(payload.rules.map((rule) => [rule.scope, rule.points, rule.no_award]), [
    ["event", "2.25", false],
    ["ticket", "0", false],
    ["ticket", null, true],
  ]);
});

test("validation rejects negative and malformed values", () => {
  const tickets = [{ id: "t1", name: "Member" }];
  assert.equal(validateEventCpdPointsConfig({
    eventRule: { points: "-0.5", trigger: "registration" },
    ticketRules: { t1: { points: "1e2", trigger: "attendance" } },
  }, tickets).length, 2);
});

test("new complex ticket references remap to database ids", () => {
  const original = { eventRule: null, ticketRules: { tmp1: { points: "1.5", trigger: "registration" } } };
  const remapped = remapEventCpdPointsTicketReferences(original, { tmp1: "db1" });
  assert.equal(remapped.ticketRules.db1.points, "1.5");
  assert.equal(original.ticketRules.tmp1.points, "1.5");
  assert.equal(eventCpdPointsConfigToPayload(remapped, [{ _dbId: "db1", name: "New" }]).rules[0].ticket_class_id, "db1");
});