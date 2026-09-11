import test from "node:test";
import assert from "node:assert/strict";

import {
  MEMBERSHIP_RETURN_ROUTES,
  classifyMembershipReturn,
  getMembershipReturnPageName,
  safeMembershipReturnPath,
} from "./membershipPaymentReturn.js";

test("all dedicated provider callback routes resolve to a public return page", () => {
  assert.equal(MEMBERSHIP_RETURN_ROUTES.length, 4);
  assert.equal(getMembershipReturnPageName("/membership/direct-debit/complete"), "DirectDebitReturn");
  assert.equal(getMembershipReturnPageName("/membership/direct-debit/cancelled/"), "DirectDebitReturn");
  assert.equal(getMembershipReturnPageName("/membership/monthly-card/complete"), "MonthlyCardReturn");
  assert.equal(getMembershipReturnPageName("/MEMBERSHIP/MONTHLY-CARD/CANCELLED"), "MonthlyCardReturn");
  assert.equal(getMembershipReturnPageName("/membership/monthly-card"), null);
});

test("continuation paths remain bounded to the current origin", () => {
  assert.equal(safeMembershipReturnPath("/join?source=site"), "/join?source=site");
  assert.equal(safeMembershipReturnPath("/join#payment"), "/join");
  assert.equal(safeMembershipReturnPath("https://attacker.example/"), null);
  assert.equal(safeMembershipReturnPath("//attacker.example/"), null);
  assert.equal(safeMembershipReturnPath("/\\attacker.example/"), null);
  assert.equal(safeMembershipReturnPath(" /join"), null);
  assert.equal(safeMembershipReturnPath(`/${"a".repeat(1025)}`), null);
});

test("return display states only claim server-verified agreement statuses", () => {
  assert.equal(classifyMembershipReturn({ provider: "direct-debit", outcome: "complete", verification: "loading" }), "loading");
  assert.equal(classifyMembershipReturn({ provider: "direct-debit", outcome: "complete", verification: "failed" }), "unverified");
  assert.equal(classifyMembershipReturn({ provider: "direct-debit", outcome: "complete", agreement: { status: "mandate_pending" } }), "setup_pending");
  assert.equal(classifyMembershipReturn({ provider: "monthly-card", outcome: "complete", agreement: { status: "payment_setup_required" } }), "verification_pending");
  assert.equal(classifyMembershipReturn({ provider: "monthly-card", outcome: "complete", agreement: { status: "first_payment_pending" } }), "payment_pending");
  assert.equal(classifyMembershipReturn({ provider: "monthly-card", outcome: "complete", agreement: { status: "active" } }), "active");
  assert.equal(classifyMembershipReturn({ provider: "monthly-card", outcome: "complete", agreement: { status: "payment_overdue" } }), "payment_attention");
  assert.equal(classifyMembershipReturn({ provider: "monthly-card", outcome: "cancelled", agreement: { status: "active" } }), "active");
  assert.equal(classifyMembershipReturn({ provider: "direct-debit", outcome: "cancelled", agreement: null }), "cancelled");
});