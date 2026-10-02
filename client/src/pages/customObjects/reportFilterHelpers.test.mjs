import test from "node:test";
import assert from "node:assert/strict";
import {
  changeFilterOperator, filterOperators, makeFilterCondition, reportFilterFields,
  validateReportFilters,
} from "./reportFilterHelpers.mjs";
import { makeReportConfig, reconcileReportConfig } from "./reportHelpers.mjs";

const start = { kind: "custom_object", customObjectId: "department" };
const path = [{ relationship_definition_id: "members", from_side: "source" }];
const definitions = [{
  id: "members", status: "active", source_kind: "custom_object",
  source_custom_object_id: "department", target_kind: "member",
  configuration: { relationship_fields: [
    { id: "responder", key: "responder", label: "Responder", type: "boolean" },
    { id: "note", label: "Note", type: "textarea" },
    { id: "amount", label: "Amount", type: "decimal" },
    { id: "tags", label: "Tags", type: "picklist" },
  ] },
}];
const check = (filters, overrides = {}) => validateReportFilters({
  filters, start, definitions, ...overrides,
});
const filter = (conditions = [], overrides = {}) => ({ mode: "none", path, conditions, ...overrides });
const boolCondition = { kind: "relationship_field", relationship_field_id: "responder", op: "equals", value: true };

test("conditionless any/none and multiple AND filters preserve row-relative final-edge definitions", () => {
  const filters = [filter(), filter([boolCondition]), filter([], { mode: "any" })];
  assert.deepEqual(check(filters), { stale: [], pending: false });
  const config = makeReportConfig("department", { filters });
  const reconciled = reconcileReportConfig({ config, objectId: "department", definitions });
  assert.equal(reconciled.config, config);
  assert.equal(reconciled.config.filters, filters);
  assert.deepEqual(reconciled.stale, []);
  const rowRelative = makeReportConfig("department", {
    grain_path: path,
    filters: [filter([], { path: [{ relationship_definition_id: "members", from_side: "target" }] })],
  });
  assert.deepEqual(reconcileReportConfig({ config: rowRelative, objectId: "department", definitions }).stale, []);
});

test("supported core text and metadata types; unsupported types are not offered", () => {
  const schema = reportFilterFields({ start, path, definitions });
  assert.equal(schema.pending, false);
  assert.equal(schema.fields.find((field) => field.id === "email").type, "text");
  assert.equal(schema.fields.find((field) => field.id === "responder").type, "boolean");
  assert.equal(schema.fields.find((field) => field.id === "tags"), undefined);
  assert.equal(schema.unsupported[0].id, "tags");
  for (const type of ["text", "textarea", "email", "url"]) assert.ok(filterOperators(type).includes("contains"));
  for (const type of ["number", "decimal"]) assert.ok(filterOperators(type).includes("gte"));
  for (const type of ["date", "file", "picklist", "country", "json", undefined]) assert.deepEqual(filterOperators(type), []);
  assert.match(check([filter([{ kind: "relationship_field", relationship_field_id: "tags", op: "equals", value: "x" }])]).stale.join(" "), /unsupported/);
});

test("strict boolean, numeric and text values with compatible operators", () => {
  assert.deepEqual(check([filter([boolCondition])]).stale, []);
  for (const value of ["true", "Yes", 1, null, undefined]) {
    assert.match(check([filter([{ ...boolCondition, value }])]).stale.join(" "), /boolean/);
  }
  assert.match(check([filter([{ ...boolCondition, op: "contains" }])]).stale.join(" "), /operator/);
  const numeric = { kind: "relationship_field", relationship_field_id: "amount", op: "gte", value: 3.75 };
  assert.deepEqual(check([filter([numeric])]).stale, []);
  for (const value of ["3.75", "", NaN, Infinity]) assert.match(check([filter([{ ...numeric, value }])]).stale.join(" "), /finite number/);
  const text = { kind: "field", field: "email", op: "contains", value: "%_.*" };
  assert.deepEqual(check([filter([text])]).stale, []);
  assert.match(check([filter([{ ...text, value: false }])]).stale.join(" "), /text value/);
  assert.match(check([filter([{ ...text, op: "gt" }])]).stale.join(" "), /operator/);
  assert.deepEqual(check([filter([{ ...boolCondition, op: "is_empty", value: undefined }])]).stale, []);
  assert.deepEqual(changeFilterOperator(boolCondition, "is_empty", "boolean"), {
    kind: "relationship_field", relationship_field_id: "responder", op: "is_empty",
  });
  assert.equal(changeFilterOperator({ ...boolCondition, op: "is_empty", value: undefined }, "equals", "boolean").value, true);
});

test("malformed definitions and limits are reported without modifying snapshots", () => {
  const cases = [
    null, {}, "bad", [null], [filter([], { mode: "bad" })], [filter([], { path: [] })],
    [filter([], { path: [null] })], [filter([], { path: [...path, ...path, ...path, ...path, ...path, ...path, ...path] })],
    [filter(null)], [filter([null])], [filter([{ kind: "count_distinct" }])],
    [filter([{ kind: "field", field: "email", field_id: "oops", op: "equals", value: "" }])],
    Array.from({ length: 11 }, () => filter()), [filter(Array.from({ length: 11 }, () => boolCondition))],
  ];
  for (const filters of cases) {
    const snapshot = JSON.stringify(filters);
    assert.ok(check(filters).stale.length, snapshot);
    assert.equal(JSON.stringify(filters), snapshot);
  }
  assert.deepEqual(check(undefined), { stale: [], pending: false });
});

test("loading/error metadata is pending, loaded empty schema is stale, no silent substitution", () => {
  const customDefinitions = [{ ...definitions[0], target_kind: "custom_object", target_custom_object_id: "project" }];
  const filters = [filter([{ kind: "field", field_id: "title", op: "equals", value: "Something" }])];
  const snapshot = JSON.stringify(filters);
  const options = { definitions: customDefinitions };
  assert.deepEqual(check(filters, options), { stale: [], pending: true });
  assert.match(check(filters, { ...options, fieldsByEndpoint: { "custom_object:project": [] } }).stale.join(" "), /unavailable/);
  assert.deepEqual(check(filters, { ...options, fieldsByEndpoint: { "custom_object:project": [
    { id: "title", label: "Title", field_type: "text" },
  ] } }), { stale: [], pending: false });
  assert.match(check(filters, { ...options, fieldsByEndpoint: { "custom_object:project": [
    { id: "title", label: "Title", field_type: "date" },
  ] } }).stale.join(" "), /unsupported/);
  assert.match(check(filters, { ...options, fieldsByEndpoint: { "custom_object:project": [
    { id: "title", field_type: "text", is_active: false },
  ] } }).stale.join(" "), /unavailable/);
  assert.deepEqual(check([filter([boolCondition])], { definitions: [], metadataLoading: true }), { stale: [], pending: true });
  assert.match(check([filter([boolCondition])], { definitions: [] }).stale.join(" "), /unavailable/);
  assert.equal(JSON.stringify(filters), snapshot);
});

test("new condition values are typed and V1 never gains filter meaning", () => {
  assert.equal(makeFilterCondition({ kind: "relationship_field", id: "responder", type: "boolean" }).value, true);
  assert.equal(makeFilterCondition({ kind: "field", custom: true, id: "amount", type: "number" }).value, 0);
  const legacy = {
    version: 1, start_object_id: "department", grain_path: [], columns: [], filters: "opaque",
  };
  const result = reconcileReportConfig({ config: legacy, objectId: "department", definitions });
  assert.equal(result.config, legacy);
  assert.deepEqual(result.stale, []);
  assert.equal(result.filtersPending, false);
});