import test from "node:test";
import assert from "node:assert/strict";
import { proposalProgress, revokeLinkAvailability } from "./proposalLifecycle.js";

const available = { status: "issued", hasActiveDeliveryLink: true, permitted: true };

test("never-sent issued proposal cannot revoke a link; sent alone is not evidence either", () => {
  for (const status of ["issued", "sent"]) {
    assert.equal(revokeLinkAvailability({ ...available, status, hasActiveDeliveryLink: false }).enabled, false);
    assert.match(revokeLinkAvailability({ ...available, status, hasActiveDeliveryLink: false }).reason, /No active customer link/);
    assert.equal(revokeLinkAvailability({ ...available, status, hasActiveDeliveryLink: undefined }).enabled, false);
  }
});

test("only an explicit boolean from a successful current read enables revocation", () => {
  assert.equal(revokeLinkAvailability(available).enabled, true);
  for (const changes of [
    { loading: true }, { error: new Error("Read failed") }, { pending: true },
    { permitted: false }, { hasActiveDeliveryLink: "true" }, { hasActiveDeliveryLink: null },
    ...["draft", "accepted", "converted", "revoked", "expired", "rejected", "superseded"].map(status => ({ status })),
  ]) {
    assert.equal(revokeLinkAvailability({ ...available, ...changes }).enabled, false, JSON.stringify(changes));
  }
});

test("revocation follows fresh server evidence after send, revoke, expiry and amendments", () => {
  const reads = [
    { status: "issued", hasActiveDeliveryLink: false },
    { status: "sent", hasActiveDeliveryLink: true },
    { status: "sent", hasActiveDeliveryLink: false }, // revoked or expired bearer
    { status: "sent", hasActiveDeliveryLink: true }, // resent
    { status: "draft", hasActiveDeliveryLink: false }, // new version
    { status: "issued", hasActiveDeliveryLink: false },
  ];
  assert.deepEqual(reads.map(read => revokeLinkAvailability({ ...available, ...read }).enabled), [false, true, false, true, false, false]);
});

test("draft, issued and sent each have a distinct current stage", () => {
  for (const status of ["draft", "issued", "sent", "accepted", "converted"]) {
    assert.deepEqual(proposalProgress(status).steps.filter(step => step.state === "current").map(step => step.id), [status]);
  }
  const issued = proposalProgress("issued");
  assert.equal(issued.steps.find(step => step.id === "sent").state, "upcoming");
  assert.match(issued.message, /locked for delivery/);
  assert.match(proposalProgress("sent").message, /awaiting a customer decision/);
});

test("manual acceptance and conversion must not invent evidence of sending", () => {
  for (const status of ["accepted", "converted"]) {
    const steps = proposalProgress(status).steps;
    assert.equal(steps.find(step => step.id === "sent").state, "unconfirmed");
    assert.equal(steps.find(step => step.id === "issued").state, "complete");
  }
  assert.equal(proposalProgress("converted").steps.find(step => step.id === "accepted").state, "complete");
});

test("terminal and unknown states never imply successful completion or an active stage", () => {
  for (const status of ["declined", "rejected", "revoked", "expired", "superseded", "unexpected"]) {
    const progress = proposalProgress(status);
    assert.ok(progress.steps.every(step => step.state === "unconfirmed"), status);
    assert.ok(progress.message);
  }
});
