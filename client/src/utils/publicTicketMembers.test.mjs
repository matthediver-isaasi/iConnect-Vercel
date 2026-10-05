import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isProvisionableRole, ticketMemberPolicy, updateTicketMemberField, validateTicketMemberPolicies, purchaseIdentity, validatePurchaseIdentities } from "./publicTicketMembers.js";

const ticket = { id: "public-ticket", name: "Public delegate", visibility_mode: "public_only", create_member_records: true, new_member_role_id: "contact", role_ids: ["eligibility"] };
const person = { first_name: "Mina", last_name: "Patel", email: "mina@example.org", organization: "Westbridge Association" };
const attendee = { first_name: "Ellis", last_name: "Reid", email: "ellis@example.org", organization: "Riverside Network" };
const item = (attendees = [attendee], ticketClass = ticket) => ({ ticketClass, attendees });

test("policy defaults off and provisioning is only public-only", () => {
  assert.deepEqual(ticketMemberPolicy(), { create_member_records: false, new_member_role_id: null });
  assert.deepEqual(ticketMemberPolicy(null), { create_member_records: false, new_member_role_id: null });
  assert.equal(ticketMemberPolicy({ ...ticket, visibility_mode: "members_and_public" }).create_member_records, false);
  assert.equal(ticketMemberPolicy({ ...ticket, create_member_records: false }).new_member_role_id, null);
});

test("visibility changes clear both fields without changing eligibility roles", () => {
  for (const visibility of ["members_only", "members_and_public"]) {
    const updated = updateTicketMemberField(ticket, "visibility_mode", visibility);
    assert.equal(updated.create_member_records, false);
    assert.equal(updated.new_member_role_id, null);
    assert.deepEqual(updated.role_ids, ["eligibility"]);
  }
  assert.equal(updateTicketMemberField(ticket, "name", "Updated").new_member_role_id, "contact");
});

test("roles with administrator, organisation, effective-date or any capacity requirement are excluded", () => {
  assert.equal(isProvisionableRole({ id: "contact", max_members: null }), true);
  for (const flag of ["is_admin", "is_tenant_admin", "requires_effective_from_date", "requires_organization"]) {
    assert.equal(isProvisionableRole({ [flag]: true }), false);
  }
  for (const capacity of [0, 12, ""]) assert.equal(isProvisionableRole({ max_members: capacity }), false);
  assert.equal(validateTicketMemberPolicies([ticket], [{ id: "contact" }]).length, 0);
  assert.equal(validateTicketMemberPolicies([ticket], [{ id: "contact", is_admin: true }]).length, 1);
  assert.equal(validateTicketMemberPolicies([{ ...ticket, new_member_role_id: null }], [{ id: "contact" }]).length, 1);
});

test("explicit purchaser and per-attendee organisation are required, never inferred", () => {
  assert.match(validatePurchaseIdentities({}, [item([person])]), /purchaser/);
  assert.match(validatePurchaseIdentities(person, [item([{ ...attendee, organization: "" }])]), /each attendee/);
  assert.equal(validatePurchaseIdentities(person, [item()]), null);
  assert.equal(validatePurchaseIdentities({}, [item([{}], { ...ticket, create_member_records: false })]), null);
});

test("email normalization and same-person deduplication preserve identity", () => {
  assert.deepEqual(purchaseIdentity({ ...person, email: " MINA@EXAMPLE.ORG ", first_name: " Mina " }), person);
  assert.equal(validatePurchaseIdentities(person, [item([{ ...person, email: " MINA@EXAMPLE.ORG " }])]), null);
  assert.match(validatePurchaseIdentities(person, [item([{ ...person, organization: "Different organisation" }])]), /conflicting identity/);
  assert.match(validatePurchaseIdentities(person, [item(), item([], { ...ticket, new_member_role_id: "delegate" })]), /different new-member roles/);
});

test("mixed baskets validate only enabled attendees; purchaser remains explicit", () => {
  assert.equal(validatePurchaseIdentities(person, [item(), item([{}], { ...ticket, create_member_records: false })]), null);
});

test("standard and complex editor serialization and checkout recovery carry the new policy/identity fields", () => {
  for (const name of ["CreateEvent", "EditEvent", "CreateComplexEvent"]) {
    const source = readFileSync(new URL(`../pages/${name}.jsx`, import.meta.url), "utf8");
    assert.match(source, /PublicTicketMemberFields/);
    assert.match(source, /validateTicketMemberPolicies/);
    assert.match(source, /\.\.\.ticketMemberPolicy/);
  }
  const payment = readFileSync(new URL("../components/booking/PaymentOptions.jsx", import.meta.url), "utf8");
  assert.match(payment, /purchaserInfo: paidPaymentSnapshot\?\.purchaserInfo/);
  assert.match(payment, /purchase_request_id: savedPayload.purchase_request_id/);
  assert.match(payment, /purchase_request_id: paidPaymentSnapshot\?\.purchase_request_id/);
  assert.match(payment, /sessionStorage.getItem\(key\) \|\| uuidv4\(\)/);
  const complex = readFileSync(new URL("../pages/ComplexEventDetail.jsx", import.meta.url), "utf8");
  assert.equal((complex.match(/purchase_request_id: data.purchase_request_id/g) || []).length, 2);
  assert.match(complex, /attendees: ci.attendees.map\(purchaseIdentity\)/);
});
