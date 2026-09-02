import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shouldShowMemberMembershipTab } from "./memberMembershipVisibility.js";

const memberDetailPage = readFileSync(
  new URL("../pages/MemberDetail.jsx", import.meta.url),
  "utf8",
);
const memberDetailView = readFileSync(
  new URL("../components/MemberDetailView.jsx", import.meta.url),
  "utf8",
);
const membershipPanel = readFileSync(
  new URL("../components/MemberMembershipTab.jsx", import.meta.url),
  "utf8",
);

test("shows membership for saved members regardless of organisation link", () => {
  assert.equal(shouldShowMemberMembershipTab({ member: { id: "linked", organization_id: "org-1" } }), true);
  assert.equal(shouldShowMemberMembershipTab({ member: { id: "unlinked", organization_id: null } }), true);
});

test("does not show membership for a new unsaved member", () => {
  assert.equal(shouldShowMemberMembershipTab({ member: {}, isNew: true }), false);
  assert.equal(shouldShowMemberMembershipTab({ member: { id: "new-id" }, isNew: true }), false);
  assert.equal(shouldShowMemberMembershipTab({ member: null, isNew: false }), false);
});

test("both member detail surfaces use the shared saved-member visibility rule", () => {
  assert.equal(
    (memberDetailPage.match(/shouldShowMemberMembershipTab\(\{ member \}\)/g) || []).length,
    2,
  );
  assert.equal(
    (memberDetailView.match(/shouldShowMemberMembershipTab\(\{ member, isNew \}\)/g) || []).length,
    2,
  );
  assert.doesNotMatch(memberDetailPage, /!member\?\.organization_id[\s\S]{0,160}membership/);
  assert.doesNotMatch(memberDetailView, /!member\?\.organization_id[\s\S]{0,160}membership/);
});

test("membership panel retains pricing, actions, verification, invoices, and history entry points", () => {
  for (const entryPoint of [
    "text-member-year",
    "button-member-simulate",
    "button-member-override",
    "button-member-approve",
    "card-member-payment-info",
    "membership-invoice",
    "text-member-no-history",
  ]) {
    assert.match(membershipPanel, new RegExp(entryPoint));
  }
});
