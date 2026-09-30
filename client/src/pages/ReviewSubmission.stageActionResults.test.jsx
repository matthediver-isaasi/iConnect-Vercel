import test from "node:test";
import assert from "node:assert/strict";
import {
  formatStageActionDetail,
  getMemberFieldMappingIssues,
  getStageActionValidationErrors,
  isMemberFieldMappingIssue,
} from "./ReviewSubmission.jsx";

test("member field mapping skips are visible even when the action result is otherwise successful", () => {
  const result = {
    action: "field_mapping",
    target_entity: "member",
    status: "success",
    mappings: [
      { field: "job_title", status: "updated" },
      { field: "mobile", status: "skipped", reason: "Source value is empty" },
    ],
  };

  assert.equal(isMemberFieldMappingIssue(result), true);
  assert.deepEqual(getMemberFieldMappingIssues(result), [result.mappings[1]]);
});

test("member field mapping errors and partial results are visible", () => {
  assert.equal(isMemberFieldMappingIssue({
    action: "field_mapping",
    target_entity: "member",
    status: "error",
    error: "Linked member not found in this tenant",
  }), true);
  assert.equal(isMemberFieldMappingIssue({
    action: "field_mapping",
    target_entity: "member",
    status: "partial",
    mappings: [{ field: "job_title", status: "error", error: "Write failed" }],
  }), true);
});

test("organisation and unrelated member actions do not open the member mapping warning", () => {
  assert.equal(isMemberFieldMappingIssue({
    action: "field_mapping",
    target_entity: "organization",
    status: "error",
  }), false);
  assert.equal(isMemberFieldMappingIssue({
    action: "create_member",
    target_entity: "member",
    status: "skipped",
  }), false);
  assert.deepEqual(getMemberFieldMappingIssues(null), []);
});

test("structured validation errors are normalized into renderable detail strings", () => {
  const result = {
    validation_errors: [
      { field: "job_title", message: "Source field is not on this form" },
      { error: "Preference is inactive" },
    ],
  };

  assert.deepEqual(getStageActionValidationErrors(result), result.validation_errors);
  assert.equal(
    formatStageActionDetail(result.validation_errors[0]),
    "job_title: Source field is not on this form",
  );
  assert.equal(formatStageActionDetail(result.validation_errors[1]), "Preference is inactive");
  assert.equal(formatStageActionDetail({ detail: "Nested detail" }), "Nested detail");
  assert.equal(formatStageActionDetail(["one", { reason: "two" }]), "one, two");
});

test("a single structured validation error is also normalized", () => {
  const result = { validation_errors: { target_field: "mobile", reason: "Field is unavailable" } };
  assert.deepEqual(getStageActionValidationErrors(result), [result.validation_errors]);
  assert.equal(formatStageActionDetail(result.validation_errors), "mobile: Field is unavailable");
});