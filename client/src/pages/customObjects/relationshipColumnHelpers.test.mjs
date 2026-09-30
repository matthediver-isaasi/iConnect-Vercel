import assert from "node:assert/strict";
import test from "node:test";
import {
  clampRelationshipColumnWidth,
  moveRelationshipColumn,
  reconcileRelationshipColumnState,
  relationshipColumnDescriptors,
  relationshipTablePreferenceKey,
} from "./relationshipColumnHelpers.mjs";

const descriptors = relationshipColumnDescriptors({
  relationshipFields: [{ id: 7, label: "Primary" }],
  previewColumns: [
    { type: "field", field_id: 9, label: "Code" },
    { type: "relationship", relationship_definition_id: 11, side: "target", label: "Owners" },
  ],
});

test("builds stable IDs for every data-column kind", () => {
  assert.deepEqual(descriptors.map((item) => item.id), [
    "record",
    "relationship-field:7",
    "field:9",
    "relationship:11:target",
  ]);
});

test("reconciliation removes stale references, appends defaults, and bounds widths", () => {
  assert.deepEqual(reconcileRelationshipColumnState(descriptors, {
    order: ["field:9", "removed", "record"],
    widths: { "field:9": 900, record: 10 },
    sortField: "field:9",
    sortDir: "desc",
  }), {
    order: ["field:9", "record", "relationship-field:7", "relationship:11:target"],
    widths: {
      "field:9": 480,
      record: 120,
      "relationship-field:7": 180,
      "relationship:11:target": 220,
    },
    sortField: "field:9",
    sortDir: "desc",
  });
  const staleSort = reconcileRelationshipColumnState(descriptors, {
    sortField: "field:removed",
    sortDir: "desc",
  });
  assert.equal(staleSort.sortField, "");
  assert.equal(staleSort.sortDir, "desc");
  assert.equal(clampRelationshipColumnWidth("bad", 200), 200);
});

test("reorder and preference scope remain deterministic", () => {
  assert.deepEqual(moveRelationshipColumn(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.equal(relationshipTablePreferenceKey({
    memberId: "m1",
    definitionId: "d1",
    side: "source",
    contextKind: "custom_object",
    objectId: "o1",
  }), "relationship_columns_m1_custom_object_o1_d1_source");
});