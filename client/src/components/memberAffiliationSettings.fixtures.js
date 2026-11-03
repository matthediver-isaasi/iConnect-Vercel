import { EMPTY_CONFIG } from "./memberAffiliationSettingsModel.js";

export function affiliationFixture() {
  const field = (id, extra = {}) => ({ id, name: "description", label: "Description", field_type: "text", is_active: true, ...extra });
  const relationship = (id, kind, objectId, reverse, cardinality, extra = {}) => ({
    id, label: "Connection", status: "active",
    source_kind: reverse ? "custom_object" : kind,
    target_kind: reverse ? kind : "custom_object",
    source_custom_object_id: reverse ? objectId : null,
    target_custom_object_id: reverse ? null : objectId,
    cardinality, ...extra,
  });
  const metadata = {
    complete: true,
    objects: [
      { id: "departments", plural_label: "Teams", status: "active", primary_display_field_id: "department-name" },
      { id: "assignments", plural_label: "Organisation links", status: "active", primary_display_field_id: "assignment-name" },
      { id: "other", plural_label: "Other records", status: "active", primary_display_field_id: "other-name" },
    ],
    fields: { departments: [field("department-name")], assignments: [field("assignment-name")], other: [field("other-name")] },
    relationships: [
      relationship("department-member", "member", "departments", false, "many_to_many"),
      relationship("department-org", "organization", "departments", true, "many_to_one"),
      relationship("assignment-member", "member", "assignments", true, "many_to_one"),
      relationship("assignment-org", "organization", "assignments", false, "one_to_many"),
    ],
  };
  const config = { ...EMPTY_CONFIG, enabled: true, memberDepartmentDefinitionId: "department-member", departmentOrganizationDefinitionId: "department-org" };
  return { config, metadata, relationship, field };
}
