import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createManualCpdSession, loadManualCpdOptions, postManualCpd, validManualCpdAward } from "./manualCpdAwards.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const fields = { template_id: "template-7", points_value: "2.75", activity_title: "Clinical review workshop", activity_date: "2026-05-21" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("requires certificate, title, date and strictly positive finite points", () => {
  assert.equal(validManualCpdAward(fields), true);
  for (const points_value of ["", "0", "-1", "Infinity", "not a number"]) {
    assert.equal(validManualCpdAward({ ...fields, points_value }), false);
  }
  assert.equal(validManualCpdAward({ ...fields, activity_title: " " }), false);
  assert.equal(validManualCpdAward({ ...fields, template_id: "" }), false);
  assert.equal(validManualCpdAward({ ...fields, activity_date: "21/05/2026" }), false);
});

test("options include credentials and encode member; preview returns only PDF bytes", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "POST") return new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf" } });
    return json({ templates: [{ id: "template-7", name: "CPD completion" }], member: { id: "member/7" } });
  };
  const data = await loadManualCpdOptions("member/7");
  assert.equal(data.templates.length, 1);
  const bytes = await postManualCpd({ action: "preview", member_id: "member/7", ...fields });
  assert.deepEqual([...bytes], [37, 80, 68, 70]);
  assert.match(calls[0].url, /member_id=member%2F7/);
  assert.ok(calls.every(call => call.options.credentials === "include"));
  assert.equal(JSON.parse(calls[1].options.body).points_value, "2.75");
  globalThis.fetch = async () => json({ not: "pdf" });
  await assert.rejects(postManualCpd({ action: "preview" }), /not a PDF/);
});

test("ambiguous award freezes the exact payload/key, even after subsequent rejection, and resolves without duplicate award", async () => {
  let keys = 0;
  const session = createManualCpdSession("member-7", () => `key-${++keys}`);
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options.body);
    if (calls.length === 1) throw new TypeError("Network lost after commit");
    if (calls.length === 2) return json({ error: "Temporarily unavailable" }, 503);
    if (calls.length === 3) return json({ error: "Validation response" }, 409);
    return json({ entry: { id: "ledger-7" }, email_status: "not_sent" });
  };
  await assert.rejects(session.award(fields));
  assert.equal(session.locked, true);
  await assert.rejects(session.award({ ...fields, points_value: "99" }));
  await assert.rejects(session.award({ ...fields, activity_title: "Changed" }));
  assert.equal(session.locked, true);
  await session.award({});
  await session.award(fields);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(body => body === calls[0]));
  assert.equal(keys, 1);
  assert.equal(session.entry.id, "ledger-7");
});

test("definitive first award rejection unlocks input; malformed success remains ambiguous", async () => {
  let keys = 0;
  const session = createManualCpdSession("member-7", () => `key-${++keys}`);
  globalThis.fetch = async () => json({ error: "Template unavailable" }, 422);
  await assert.rejects(session.award(fields), /Template unavailable/);
  assert.equal(session.locked, false);
  globalThis.fetch = async () => json({ entry: {} });
  await assert.rejects(session.award({ ...fields, points_value: "3.25" }));
  assert.equal(session.locked, true);
  assert.equal(keys, 2);
});

test("email failure and pending/unknown retries retain saved award and original message/key; never award again", async () => {
  let keys = 0;
  const session = createManualCpdSession("member-7", () => `key-${++keys}`);
  await assert.rejects(session.email("<p>Too soon</p>"), /Save the award/);
  const calls = [];
  const statuses = ["failed", "pending", "unknown", "sent"];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.action === "award") return json({ entry: { id: "ledger-7" }, email_status: "not_sent" });
    if (calls.length === 2) throw new TypeError("Delivery response lost");
    return json({ status: statuses.shift() });
  };
  await session.award(fields);
  await assert.rejects(session.email("<p>Your certificate</p>"));
  for (const expected of ["failed", "pending", "unknown", "sent"]) {
    assert.equal((await session.email("<p>Edited after sending</p>")).status, expected);
  }
  await session.award(fields);
  assert.equal(calls.filter(call => call.action === "award").length, 1);
  assert.ok(calls.slice(1).every(call => call.ledger_entry_id === "ledger-7"
    && call.message_html === "<p>Your certificate</p>" && call.idempotency_key === "key-2"));
  assert.equal(session.entry.id, "ledger-7");
  assert.equal(session.emailLocked, true);
});
