import test from "node:test";
import assert from "node:assert/strict";
import {
  cardinalityLimitReached,
  applicableSidesForRecord,
  displaySide,
  relationshipCreatePayload,
  relationshipPayload,
  relationshipPanels,
  relatedRecordPath,
} from "./relationshipHelpers.js";

test("identifies the configured side without recursive lookups", () => {
  assert.equal(
    displaySide(
      { source_kind: "custom_object", source_custom_object_id: "8", target_kind: "member" },
      "custom_object",
      8,
    ),
    "source",
  );
});

test("enumerates both stable sides for a self relationship", () => {
  assert.deepEqual(
    applicableSidesForRecord(
      {
        source_kind: "custom_object",
        source_custom_object_id: "8",
        target_kind: "custom_object",
        target_custom_object_id: "8",
      },
      "custom_object",
      8,
    ),
    ["source", "target"],
  );
});

test("applies one-side limits from the perspective being edited", () => {
  assert.equal(cardinalityLimitReached({ cardinality: "one_to_many" }, "target", 1), true);
  assert.equal(cardinalityLimitReached({ cardinality: "one_to_many" }, "source", 4), false);
  assert.equal(cardinalityLimitReached({ cardinality: "one_to_one" }, "source", 1), true);
});

test("builds edge payload with endpoints in their defined order", () => {
  assert.deepEqual(
    relationshipPayload({ definitionId: 3, recordId: 9, entityId: 14, editSide: "target" }),
    {
      relationship_definition_id: 3,
      source_record_id: 14,
      target_record_id: 9,
      routed_side: "target",
      routed_record_id: 9,
    },
  );
});

test("builds the core create payload expected by the core relationship service", () => {
  assert.deepEqual(
    relationshipCreatePayload({
      contextKind: "member",
      definitionId: 3,
      recordId: 9,
      entityId: 14,
      editSide: "source",
    }),
    {
      relationship_definition_id: 3,
      related_record_id: 14,
    },
  );
});

test("no relationship metadata produces no dynamic tabs", () => {
  assert.deepEqual(
    relationshipPanels({ data: [] }, { kind: "organization", recordId: "12" }),
    [],
  );
  assert.deepEqual(
    relationshipPanels(undefined, { kind: "organization_group", recordId: "4" }),
    [],
  );
});

test("core metadata controls side, label count and visibility", () => {
  const panels = relationshipPanels({
    data: [{
      side: "target",
      count: 3,
      definition: {
        id: 7,
        status: "active",
        target_kind: "member",
        target_label: "Qualifications",
        show_on_target: true,
      },
    }],
  }, { kind: "member", recordId: "9" });
  assert.equal(panels.length, 1);
  assert.equal(panels[0].side, "target");
  assert.equal(panels[0].count, 3);
});

test("archived definitions are shown only in explicit history mode", () => {
  const payload = {
    data: [{
      id: "definition-1",
      status: "archived",
      source_kind: "custom_object",
      source_custom_object_id: "object-1",
      source_label: "Historic links",
      show_on_source: true,
    }],
  };
  const context = { kind: "custom_object", objectId: "object-1", recordId: "record-1" };
  assert.deepEqual(relationshipPanels(payload, context), []);
  assert.equal(
    relationshipPanels(payload, context, { includeArchived: true }).length,
    1,
  );
});

test("builds links for core and custom related records", () => {
  assert.equal(relatedRecordPath({ kind: "member", id: "3" }), "/members/3");
  assert.equal(
    relatedRecordPath({ kind: "custom_object", custom_object_id: "8", id: "2" }),
    "/CustomObjectsAdmin/8/records/2",
  );
});