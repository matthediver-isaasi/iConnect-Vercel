import assert from "node:assert/strict";
import test from "node:test";
import { bounceListParams, canQueryMemberBounce, memberBounceKey, recipientDeliveryStatus, matchesDeliveryOutcome, readBounceResponse, resolutionPayload } from "./bounceModel.mjs";

test("member cache identity includes member and current email; absent email disables request", () => {
  assert.notDeepEqual(memberBounceKey("member-1", "old@example.test"), memberBounceKey("member-1", "new@example.test"));
  assert.notDeepEqual(memberBounceKey("member-1", "same@example.test"), memberBounceKey("member-2", "same@example.test"));
  assert.equal(canQueryMemberBounce("member-1", "  "), false);
  assert.equal(canQueryMemberBounce(null, "r@example.test"), false);
  assert.equal(canQueryMemberBounce("member-1", "r@example.test"), true);
});

test("filters encode user search safely", () => {
  const params = new URLSearchParams(bounceListParams("resolved", 3, "  m+tag@example.test & x  "));
  assert.equal(params.get("view"), "resolved");
  assert.equal(params.get("page"), "3");
  assert.equal(params.get("search"), "m+tag@example.test & x");
});

test("resolution requires reason and sends the exact optimistic concurrency timestamp", () => {
  const item = { id: "bounce-1", last_bounced_at: "2026-05-12T12:31:22.123Z", email: "m@example.test" };
  assert.throws(() => resolutionPayload(item, "  "), /reason/);
  assert.throws(() => resolutionPayload({ id: "bounce-1" }, "Corrected"), /Refresh/);
  assert.deepEqual(resolutionPayload(item, "  Provider suppression resolved  "), {
    id: "bounce-1", expectedLastBouncedAt: item.last_bounced_at, reason: "Provider suppression resolved",
  });
});

test("409 explains provider resolution first without claiming provider state was changed", async () => {
  await assert.rejects(readBounceResponse(new Response(JSON.stringify({ error: "Still suppressed" }), { status: 409 })), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /administrator must resolve that suppression with the provider first/);
    assert.match(error.message, /Refresh/);
    assert.match(error.message, /Still suppressed/);
    return true;
  });
  await assert.rejects(readBounceResponse(new Response("not json", { status: 503 })), /could not be loaded/);
  assert.deepEqual(await readBounceResponse(new Response('{"item":null}')), { item: null });
});

test("delivery outcome overrides protected engagement status without mutating it", () => {
  for (const [outcome, label] of [["hard_bounce", "Hard bounce"], ["soft_bounce", "Soft bounce · retrying"], ["delivery_failed", "Delivery failed after retries"]]) {
    const recipient = Object.freeze({ status: "clicked", delivery_outcome: outcome });
    assert.equal(recipientDeliveryStatus(recipient).label, label);
    assert.equal(matchesDeliveryOutcome(recipient, outcome), true);
    assert.equal(matchesDeliveryOutcome(recipient, "delivered"), false);
    assert.equal(recipient.status, "clicked");
  }
  for (const outcome of [null, "delivered"]) {
    for (const status of ["clicked", "opened", "delivered", "unsubscribed"]) {
      assert.equal(recipientDeliveryStatus({ status, delivery_outcome: outcome }).label, status);
    }
  }
});
