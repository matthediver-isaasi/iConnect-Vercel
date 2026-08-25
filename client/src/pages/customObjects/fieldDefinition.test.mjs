import test from "node:test";
import assert from "node:assert/strict";
import { activationReadiness, createFieldPayload, validateFieldDefinition } from "./fieldDefinition.js";

test("creates a normalized selection payload", () => {
  const payload = createFieldPayload({
    name: "  Committee type ", label: "Committee type", field_type: "dropdown",
    options: [{ value: "exec", label: "Executive" }, { value: "", label: "" }],
    min_selections: "", max_selections: "", min_length: "", max_length: "",
    allowed_file_types: [], all_countries: true, selected_countries: [],
    default_country: "", default_countries: [], public_access: false,
  }, null, 3);
  assert.equal(payload.name, "committee_type");
  assert.deepEqual(payload.options, [{ value: "exec", label: "Executive" }]);
  assert.equal(payload.display_order, 3);
});

test("filters stale restricted-country defaults", () => {
  const payload = createFieldPayload({
    name: "regions", label: "Regions", field_type: "countries", options: [],
    min_selections: "", max_selections: "", min_length: "", max_length: "",
    allowed_file_types: [], public_access: false, all_countries: false,
    selected_countries: ["AU", "NZ"], default_country: "US",
    default_countries: ["AU", "US", "NZ"],
  }, null, 0);
  assert.deepEqual(payload.default_countries, ["AU", "NZ"]);
  const single = createFieldPayload({ ...payload, field_type: "country", default_country: "US" }, null, 0);
  assert.equal(single.default_country, null);
});

test("validates constrained definitions", () => {
  const base = { name: "file", label: "File", field_type: "file", options: [], allowed_file_types: [], all_countries: true, selected_countries: [], min_selections: "", max_selections: "", min_length: "", max_length: "" };
  assert.equal(validateFieldDefinition(base), "Choose at least one allowed file type.");
  assert.equal(validateFieldDefinition({ ...base, field_type: "picklist", options: [] }), "Add at least one complete option for this selection field.");
});

test("reports activation readiness from active fields and primary selection", () => {
  assert.deepEqual(activationReadiness({ primary_display_field_id: "f1" }, [{ id: "f1" }]).map((item) => item.done), [true, true]);
  assert.deepEqual(activationReadiness({ primary_display_field_id: "missing" }, []).map((item) => item.done), [false, false]);
});