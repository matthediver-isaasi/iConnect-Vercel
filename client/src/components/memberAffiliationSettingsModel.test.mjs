import assert from "node:assert/strict";
import { test } from "node:test";
import { affiliationChoices, affiliationValidation, displayName, EMPTY_CONFIG } from "./memberAffiliationSettingsModel.js";
import { affiliationFixture } from "./memberAffiliationSettings.fixtures.js";
import { validateProfileAffiliationConfig } from "../../../api/_lib/profileAffiliationPolicy.js";

const ids = choices => choices.map(row => row.id);
test("both endpoint directions resolve actual member and organisation kinds", () => {
  for (const reverse of [false, true]) {
    const { config, metadata, relationship } = affiliationFixture();
    metadata.relationships = [
      relationship("department-member", "member", "departments", reverse, "many_to_many"),
      relationship("department-org", "organization", "departments", reverse, reverse ? "many_to_one" : "one_to_many"),
      relationship("assignment-member", "member", "assignments", reverse, reverse ? "many_to_one" : "one_to_many"),
      relationship("assignment-org", "organization", "assignments", reverse, reverse ? "many_to_one" : "one_to_many"),
    ];
    Object.assign(config, { secondaryMemberDefinitionId: "assignment-member", secondaryOrganizationDefinitionId: "assignment-org" });
    const choices = affiliationChoices(config, metadata);
    assert.deepEqual(ids(choices.departmentOrganizationDefinitionId), ["department-org"]);
    assert.deepEqual(ids(choices.secondaryOrganizationDefinitionId), ["assignment-org"]);
    assert.equal(affiliationValidation(config, metadata, choices).valid, true);
    assert.doesNotThrow(() => validateProfileAffiliationConfig(config, metadata));
  }
});

test("misleading names, wrong kinds, foreign custom IDs, inactive relationships and objects are excluded", () => {
  const { config, metadata, relationship } = affiliationFixture();
  metadata.relationships.push(
    relationship("fake-org", "member", "departments", true, "many_to_one", { label: "Department organisation owner" }),
    relationship("foreign-org", "organization", "other", true, "many_to_one"),
    relationship("inactive-org", "organization", "departments", true, "many_to_one", { status: "archived" }),
    relationship("bad-cardinality", "organization", "departments", true, "many_to_many"),
    relationship("bad-kind", "organization", "departments", true, "many_to_one", { source_kind: "event" }),
  );
  assert.deepEqual(ids(affiliationChoices(config, metadata).departmentOrganizationDefinitionId), ["department-org"]);
  metadata.objects[0].status = "archived";
  assert.deepEqual(ids(affiliationChoices(config, metadata).memberDepartmentDefinitionId), []);
});

test("dependent choices require the selected, compatible parent and same custom object", () => {
  const { config, metadata, relationship } = affiliationFixture();
  const before = structuredClone(config);
  assert.deepEqual(ids(affiliationChoices(EMPTY_CONFIG, metadata).departmentOrganizationDefinitionId), []);
  assert.deepEqual(ids(affiliationChoices(config, metadata).secondaryOrganizationDefinitionId), []);
  metadata.relationships.push(relationship("other-org", "organization", "other", false, "one_to_many"));
  const next = { ...config, secondaryMemberDefinitionId: "assignment-member", secondaryOrganizationDefinitionId: "assignment-org" };
  const choices = affiliationChoices(next, metadata);
  assert.deepEqual(ids(choices.secondaryOrganizationDefinitionId), ["assignment-org"]);
  assert.deepEqual(ids(choices.secondaryLabelFieldId), ["assignment-name"]);
  assert.deepEqual(config, before);
  const changed = { ...next, memberDepartmentDefinitionId: "missing" };
  assert.deepEqual(ids(affiliationChoices(changed, metadata).secondaryLabelFieldId), []);
  assert.equal(changed.secondaryOrganizationDefinitionId, "assignment-org");
});

test("absent, invalid, and unavailable selections are not mutated and block enabling, not disabled draft saves", () => {
  const { config, metadata } = affiliationFixture();
  for (const value of [null, "unknown", "assignment-member"]) {
    const draft = { ...config, memberDepartmentDefinitionId: value, secondaryLabelFieldId: "unavailable-field" };
    const before = structuredClone(draft);
    assert.equal(affiliationValidation(draft, metadata, affiliationChoices(draft, metadata)).valid, false);
    assert.deepEqual(draft, before);
    draft.enabled = false;
    assert.equal(affiliationValidation(draft, metadata, affiliationChoices(draft, metadata)).valid, true);
    assert.equal(draft.secondaryLabelFieldId, "unavailable-field");
  }
});

test("duplicate display names remain distinct without exposing identifiers, including UUID-like names", () => {
  const { config, metadata } = affiliationFixture();
  metadata.relationships.push({ ...metadata.relationships[0], id: "a93e928c-aad5-4e89-a42f-e8406c0b8822" });
  const options = affiliationChoices(config, metadata).memberDepartmentDefinitionId;
  assert.deepEqual(options.map(row => row.label), ["Teams — Connection — choice 1", "Teams — Connection — choice 2"]);
  assert.equal(new Set(options.map(row => row.id)).size, 2);
  assert.equal(displayName({ name: "a93e928c-aad5-4e89-a42f-e8406c0b8822" }, "Unnamed"), "Unnamed");
});

test("display fields, unsafe department fields, required assignment input, and text label restrictions follow policy", () => {
  const { config, metadata, field } = affiliationFixture();
  metadata.fields.departments[0].archived_at = "2026-01-01";
  assert.deepEqual(affiliationChoices(config, metadata).memberDepartmentDefinitionId, []);
  delete metadata.fields.departments[0].archived_at;
  metadata.relationships[0].configuration = { relationship_fields: [{ type: "boolean", default: true }] };
  assert.deepEqual(affiliationChoices(config, metadata).memberDepartmentDefinitionId, []);
  metadata.relationships[0].configuration = {};
  metadata.fields.assignments.push(field("required", { is_required: true }));
  Object.assign(config, { secondaryMemberDefinitionId: "assignment-member", secondaryOrganizationDefinitionId: "assignment-org" });
  let choices = affiliationChoices(config, metadata);
  assert.deepEqual(ids(choices.secondaryLabelFieldId), ["required"]);
  assert.equal(affiliationValidation(config, metadata, choices).valid, false);
  config.secondaryLabelFieldId = "required";
  assert.equal(affiliationValidation(config, metadata, choices).valid, true);
  metadata.fields.assignments.push(field("number", { field_type: "number", is_required: true }));
  choices = affiliationChoices(config, metadata);
  assert.deepEqual(choices.secondaryMemberDefinitionId, []);
});

test("server scope validation is authoritative and receives a plain-language review action", () => {
  const { config, metadata } = affiliationFixture();
  metadata.relationships[0].configuration = { picker_scope: { match: "intersects", version: 2 } };
  const result = affiliationValidation(config, metadata, affiliationChoices(config, metadata));
  assert.equal(result.valid, false);
  assert.match(result.policyIssue, /access rules.*Technical details/);
});

test("scoped and metadata-bearing additional organisation connections are excluded", () => {
  const { config, metadata } = affiliationFixture();
  config.secondaryMemberDefinitionId = "assignment-member";
  metadata.relationships[3].configuration = { picker_scope: { version: 2 } };
  assert.deepEqual(affiliationChoices(config, metadata).secondaryOrganizationDefinitionId, []);
  metadata.relationships[3].configuration = { relationshipFields: [{ type: "text" }] };
  assert.deepEqual(affiliationChoices(config, metadata).secondaryOrganizationDefinitionId, []);
});
