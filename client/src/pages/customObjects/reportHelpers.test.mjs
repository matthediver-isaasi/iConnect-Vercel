import assert from "node:assert/strict";
import test from "node:test";
import {
  makeReportConfig, moveReportColumn, reconcileReportConfig, reportPathLabel,
} from "./reportHelpers.mjs";

const department = { id: "department", plural_label: "Departments" };
const definitions = [{
  id: "department-member", status: "active",
  relationship_key: "department_member", source_label: "Members",
  source_kind: "custom_object", source_custom_object_id: "department",
  target_kind: "member", target_custom_object_id: null,
}];

test("report path labels are schema driven", () => {
  assert.equal(reportPathLabel(
    [{ relationship_definition_id: "department-member", from_side: "source" }],
    definitions, [], department,
  ), "Departments → Members [department_member] → Member");
});

test("report reconciliation flags unsupported versions without retargeting", () => {
  const result = reconcileReportConfig({
    config: makeReportConfig("department", { version: 2 }),
    objectId: "department",
    definitions: [],
    fieldsByEndpoint: {},
  });
  assert.equal(result.config.version, 2);
  assert.match(result.stale.join(" "), /version 2 is not supported/);
});

test("report reconciliation marks removed fields without retargeting them", () => {
  const result = reconcileReportConfig({
    objectId: "department", definitions,
    fieldsByEndpoint: { "member:": [{ id: "email" }] },
    config: makeReportConfig("department", {
      grain_path: [{ relationship_definition_id: "department-member", from_side: "source" }],
      columns: [{ kind: "field", path: [{ relationship_definition_id: "department-member", from_side: "source" }], field_id: "old_email", label: "Email" }],
    }),
  });
  assert.match(result.stale.join(" "), /Email/);
});

test("report column reordering is bounded and stable", () => {
  assert.deepEqual(moveReportColumn([{ id: "a" }, { id: "b" }], 1, -1).map((item) => item.id), ["b", "a"]);
  assert.deepEqual(moveReportColumn([{ id: "a" }], 0, -1).map((item) => item.id), ["a"]);
});