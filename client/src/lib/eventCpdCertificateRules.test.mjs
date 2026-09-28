import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyEventCpdCertificateConfig,
  eventCpdCertificateConfigToPayload,
  normalizeEventCpdCertificateConfig,
  remapEventCpdCertificateTicketReferences,
  validateEventCpdCertificateConfig,
} from "./eventCpdCertificateRules.js";

test("default dates follow the event and ticket override modes remain independent", () => {
  const config = emptyEventCpdCertificateConfig();
  assert.deepEqual(config.eventRule, { template_id: null, date_mode: "event", start_date: null, end_date: null });
  config.ticketRules.t1 = {
    template_mode: "none", template_id: null,
    date_mode: "custom", start_date: "2026-02-01", end_date: null,
  };
  assert.deepEqual(eventCpdCertificateConfigToPayload(config, [{ id: "t1" }]).ticketRules.t1, config.ticketRules.t1);
});

test("discard removed ticket overrides but preserve live stable references", () => {
  const config = emptyEventCpdCertificateConfig();
  config.ticketRules = {
    tmp: { template_mode: "inherit", template_id: null, date_mode: "inherit", start_date: null, end_date: null },
    removed: { template_mode: "none", template_id: null, date_mode: "inherit", start_date: null, end_date: null },
  };
  const remapped = remapEventCpdCertificateTicketReferences(config, { tmp: "db1" });
  assert.equal(config.ticketRules.tmp.template_mode, "inherit");
  assert.deepEqual(Object.keys(eventCpdCertificateConfigToPayload(remapped, [{ _dbId: "db1" }])), ["eventRule", "ticketRules"]);
  assert.deepEqual(Object.keys(eventCpdCertificateConfigToPayload(remapped, [{ _dbId: "db1" }]).ticketRules), ["db1"]);
});

test("custom start date is required, optional end may be empty, and invalid ranges are blocked", () => {
  const config = emptyEventCpdCertificateConfig();
  config.eventRule.date_mode = "custom";
  assert.ok(validateEventCpdCertificateConfig(config).length);
  config.eventRule.start_date = "2026-02-03";
  assert.deepEqual(validateEventCpdCertificateConfig(config), []);
  config.eventRule.end_date = "2026-02-02";
  assert.ok(validateEventCpdCertificateConfig(config).length);
});

test("loaded overrides retain unavailable template IDs visibly instead of resetting them", () => {
  const loaded = normalizeEventCpdCertificateConfig({
    eventRule: { template_id: "archived-id", date_mode: "event" },
    ticketRules: { t1: { template_mode: "override", template_id: "missing-id", date_mode: "inherit" } },
  });
  assert.equal(loaded.eventRule.template_id, "archived-id");
  assert.equal(loaded.ticketRules.t1.template_id, "missing-id");
  assert.equal(loaded.ticketRules.t1.start_date, null);
});