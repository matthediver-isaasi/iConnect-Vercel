import test from "node:test";
import assert from "node:assert/strict";
import { assignmentCategories, linkSponsorOrganization } from "./eventSponsorState.mjs";

test("the same sponsor has independent categories on two events", () => {
  const first = assignmentCategories([{ sponsor_id: "sponsor", category_id: "event-a-gold" }]);
  const second = assignmentCategories([{ sponsor_id: "sponsor", category_id: "event-b-partner" }]);
  first.sponsor = null;
  assert.equal(second.sponsor, "event-b-partner");
});

test("uncategorised assignments are explicit and have no global fallback", () => {
  assert.deepEqual(assignmentCategories([{ sponsor_id: "sponsor", category_id: null }]), { sponsor: null });
  assert.deepEqual(assignmentCategories([]), {});
});

test("organisation linking fills an empty name and preserves all manual display details", () => {
  const form = { name: " ", logo_url: "manual.svg", website_url: "https://manual.test", description: "Manual", organization_id: null };
  const org = Object.freeze({ id: "org-a", name: "Society Partner", logo_url: "org.svg" });
  const linked = linkSponsorOrganization(form, org);
  assert.deepEqual(linked, { ...form, name: "Society Partner", organization_id: "org-a" });
  assert.equal(form.organization_id, null);
  assert.equal(linkSponsorOrganization({ ...form, name: "Custom sponsor" }, org).name, "Custom sponsor");
  assert.deepEqual(linkSponsorOrganization(linked, null), { ...linked, organization_id: null });
});
