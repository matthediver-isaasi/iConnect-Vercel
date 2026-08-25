import test from "node:test";
import assert from "node:assert/strict";
import {
  cardinalityLimitReached,
  applicableSidesForRecord,
  displaySide,
  relationshipPayload,
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