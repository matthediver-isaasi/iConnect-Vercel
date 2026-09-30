import assert from "node:assert/strict";
import test from "node:test";
import {
  endpointLabel, makeReportConfig, moveReportColumn, reconcileReportConfig, reportPathLabel,
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

test("custom endpoint labels use graph object metadata and unique id fallbacks", () => {
  assert.equal(endpointLabel(
    { kind: "custom_object", customObjectId: "project" },
    [{ id: "project", plural_label: "Projects" }],
    department,
  ), "Projects");
  assert.equal(endpointLabel(
    { kind: "custom_object", customObjectId: "missing-object" },
    [],
    department,
  ), "Custom object (missing-object)");
});

test("report reconciliation flags unsupported versions without retargeting", () => {
  const result = reconcileReportConfig({
    config: makeReportConfig("department", { version: 99, start_endpoint: { kind: "member" } }),
    objectId: "department",
    definitions: [],
    fieldsByEndpoint: {},
  });
  assert.equal(result.config.version, 99);
  assert.match(result.stale.join(" "), /version 99 is not supported/);
});

test("report reconciliation treats a missing version as unknown", () => {
  const malformed = { start_object_id: "department", grain_path: null, columns: [] };
  const result = reconcileReportConfig({
    config: malformed,
    objectId: "department",
  });
  assert.equal(result.config.version, undefined);
  assert.equal(result.config, malformed);
  assert.equal(result.config.grain_path, null);
  assert.match(result.stale.join(" "), /version unknown is not supported/);
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

test("new reports use the V2 owner and path contract", () => {
  assert.deepEqual(makeReportConfig("department"), {
    version: 2,
    start_object_id: "department",
    start_endpoint: { kind: "custom_object", customObjectId: "department" },
    grain_path: [],
    include_empty: false,
    columns: [],
    multi_value: "join",
  });
});

test("loading V1 does not add V2 properties or change owner-relative semantics", () => {
  const legacy = {
    version: 1,
    start_object_id: "department",
    grain_path: [{ relationship_definition_id: "department-member", from_side: "source" }],
    columns: [{ kind: "field", path: [], field_id: "name", label: "Department" }],
    multi_value: "join",
  };
  const result = reconcileReportConfig({
    config: legacy,
    objectId: "department",
    definitions,
    fieldsByEndpoint: { "custom_object:department": [{ id: "name" }] },
  });
  assert.deepEqual(result.config, legacy);
  assert.equal(result.rowEndpoint.kind, "member");
  assert.equal(result.stale.length, 0);
});

test("V2 accepts a connected starting endpoint and resolves paths from it", () => {
  const result = reconcileReportConfig({
    objectId: "department",
    definitions,
    fieldsByEndpoint: {},
    config: makeReportConfig("department", {
      start_endpoint: { kind: "member" },
      grain_path: [],
      include_empty: true,
      columns: [{ kind: "field", path: [], field: "email", label: "Email" }],
    }),
  });
  assert.equal(result.rowEndpoint.kind, "member");
  assert.deepEqual(result.stale, []);
});

test("V2 flags disconnected starts and invalid paths without retargeting", () => {
  const config = makeReportConfig("department", {
    start_endpoint: { kind: "organization" },
    grain_path: [{ relationship_definition_id: "missing", from_side: "source" }],
  });
  const result = reconcileReportConfig({
    config, objectId: "department", definitions, fieldsByEndpoint: {},
  });
  assert.equal(result.config.start_endpoint.kind, "organization");
  assert.deepEqual(result.config.grain_path, config.grain_path);
  assert.match(result.stale.join(" "), /starting entity is unavailable|disconnected/);
  assert.match(result.stale.join(" "), /unavailable or disconnected relationship/);
});

test("persisted V2 malformed shapes are flagged and preserved verbatim", () => {
  for (const config of [
    { version: 2, start_object_id: "department", grain_path: [], columns: [], include_empty: false },
    { version: 2, start_object_id: "department", start_endpoint: "member", grain_path: {}, columns: "bad", include_empty: "yes" },
  ]) {
    const result = reconcileReportConfig({
      config, objectId: "department", definitions, fieldsByEndpoint: {},
    });
    assert.equal(result.config, config);
    assert.ok(result.stale.length > 0);
  }
});

test("unsupported persisted versions remain opaque", () => {
  const config = { version: 47, arbitrary_future_shape: ["unchanged"] };
  const result = reconcileReportConfig({ config, objectId: "department" });
  assert.equal(result.config, config);
  assert.deepEqual(result.config, { version: 47, arbitrary_future_shape: ["unchanged"] });
  assert.match(result.stale.join(" "), /version 47/);
});

test("V2 distinct counts require a nonempty row-relative path", () => {
  const empty = reconcileReportConfig({
    objectId: "department", definitions, fieldsByEndpoint: {},
    config: makeReportConfig("department", {
      columns: [{ kind: "count_distinct", path: [], label: "Members" }],
    }),
  });
  assert.match(empty.stale.join(" "), /must have a related path/);

  const valid = reconcileReportConfig({
    objectId: "department", definitions, fieldsByEndpoint: {},
    config: makeReportConfig("department", {
      columns: [{
        kind: "count_distinct",
        path: [{ relationship_definition_id: "department-member", from_side: "source" }],
        label: "Members",
      }],
    }),
  });
  assert.deepEqual(valid.stale, []);
});