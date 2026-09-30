import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleOrganisationDirectoryRelationships,
  organisationDirectoryPresentation,
} from "./organisationDirectoryPresentation.js";

test("organisation directory presentation is opt-in with no implicit fields", () => {
  assert.deepEqual(organisationDirectoryPresentation(), {
    enabled: false,
    relationships: [],
    field_ids: [],
  });
});

test("eligible directory relationships use the Organisation endpoint direction", () => {
  const eligible = eligibleOrganisationDirectoryRelationships([
    {
      id: "organisation-department",
      status: "active",
      source_kind: "organization",
      target_kind: "custom_object",
      target_custom_object_id: "department",
      source_label: "Departments",
    },
    {
      id: "archived",
      status: "archived",
      source_kind: "custom_object",
      source_custom_object_id: "department",
      target_kind: "organization",
    },
    {
      id: "indirect",
      status: "active",
      source_kind: "member",
      target_kind: "organization",
    },
    {
      id: "archived-at",
      status: "active",
      archived_at: "2026-01-01T00:00:00.000Z",
      source_kind: "organization",
      target_kind: "custom_object",
      target_custom_object_id: "department",
    },
  ], "department");
  assert.deepEqual(
    eligible.map(({ relationship_id, direction }) => ({ relationship_id, direction })),
    [{ relationship_id: "organisation-department", direction: "source" }],
  );
});