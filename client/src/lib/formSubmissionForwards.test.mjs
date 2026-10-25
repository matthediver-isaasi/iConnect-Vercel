import test from "node:test";
import assert from "node:assert/strict";
import { createSubmissionForwardSession, forwardDisplayStatus, groupSubmissionForwards, submissionForwardBatchIds } from "./formSubmissionForwards.mjs";

test("uncertain retry retains exact UUID, recipient and message", async () => {
  const calls = [];
  let keys = 0;
  const session = createSubmissionForwardSession("submission-1", async payload => {
    calls.push(payload);
    if (calls.length === 1) throw new Error("Network lost");
    return { forward: { id: "forward-1", status: "sent" } };
  }, () => `uuid-${++keys}`);
  await assert.rejects(session.send("member-1", "<p>Original</p>"), /Network lost/);
  assert.equal(session.pending, false);
  await session.send("member-2", "<p>Changed</p>");
  assert.strictEqual(calls[0], calls[1]);
  assert.deepEqual(calls[1], { submission_id: "submission-1", member_id: "member-1", message_html: "<p>Original</p>", idempotency_key: "uuid-1" });
  await session.send("member-3", "Another");
  assert.equal(calls.length, 2, "sent receipt never sends again");
  assert.equal(keys, 1);
});

for (const status of ["unknown", "sending", "failed"]) {
  test(`${status} receipt never schedules automatic retry or changes key`, async () => {
    const calls = [];
    const session = createSubmissionForwardSession("submission", async payload => {
      calls.push(payload);
      return { forward: { id: "forward", status } };
    }, () => "fixed-uuid");
    await session.send("member", "Message");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.length, 1);
    await session.send("other-member", "Different");
    assert.strictEqual(calls[0], calls[1]);
  });
}

test("malformed receipt keeps immutable original payload", async () => {
  const session = createSubmissionForwardSession("submission", async () => ({ forward: {} }), () => "uuid");
  await assert.rejects(session.send("member", "Message"), /could not be confirmed/);
  assert.equal(session.payload.idempotency_key, "uuid");
  assert.ok(Object.isFrozen(session.payload));
});

test("rapid double-send cannot issue parallel requests", async () => {
  let finish;
  let calls = 0;
  const session = createSubmissionForwardSession("submission", () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, () => "uuid");
  const first = session.send("member", "");
  await assert.rejects(session.send("member", ""), /already in progress/);
  assert.equal(calls, 1);
  finish({ forward: { id: "forward", status: "sent" } });
  await first;
});

test("history reports revoked and expired links ahead of delivery status", () => {
  assert.equal(forwardDisplayStatus({ status: "sent", revoked_at: "2026-01-01" }), "Revoked");
  assert.equal(forwardDisplayStatus({ status: "sent", expires_at: "2026-01-01" }, Date.parse("2026-01-02")), "Expired");
  assert.equal(forwardDisplayStatus({ status: "unknown" }), "Delivery unconfirmed");
});

test("visible-list batches deduplicate, stabilize order and respect the 100-ID API limit", () => {
  assert.deepEqual(submissionForwardBatchIds([{ id: "b" }, { id: "a" }, { id: "b" }, null]), ["a", "b"]);
  assert.equal(submissionForwardBatchIds(Array.from({ length: 150 }, (_, index) => ({ id: `submission-${index}` }))).length, 100);
  assert.deepEqual(submissionForwardBatchIds([]), []);
});

test("bulk history is partitioned by submission without exposing other rows or granting send authorization", () => {
  const rows = [{ id: "f-a", submission_id: "a" }, { id: "f-b", submission_id: "b" }, { id: "missing-submission" }];
  const grouped = groupSubmissionForwards(rows);
  assert.deepEqual(grouped.a, [rows[0]]);
  assert.deepEqual(grouped.b, [rows[1]]);
  assert.equal(grouped.can_forward, undefined);
  assert.equal(grouped.c, undefined);
});
