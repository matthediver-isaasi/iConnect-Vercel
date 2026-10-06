import test from "node:test";
import assert from "node:assert/strict";
import { cleanOrganisationDirectoryFilters } from "./organisationDirectoryFilterCleanup.js";

test("single modes clear multiple choice selections, without coercion or dropping number ranges", () => {
  const filters = {
    choice: { operator: "eq", value: ["a", "b"] },
    source: { operator: "eq", value: ["x", "y"] },
    single: { operator: "eq", value: ["a"] },
    multi: { operator: "eq", value: ["a", "b"] },
    range: { operator: "between", value: [3, 12] },
    revoked: { operator: "contains", value: "private" },
  };
  const result = cleanOrganisationDirectoryFilters(filters, [
    { key: "choice", label: "Specialty", control: "choice", multi_select: false },
    { key: "source", label: "Programme", control: "source-choice", multi_select: false },
    { key: "single", control: "choice", multi_select: false },
    { key: "multi", control: "choice", multi_select: true },
    { key: "range", control: "number", multi_select: false },
  ]);
  assert.deepEqual(result.singleSelectionLabels, ["Specialty", "Programme"]);
  assert.deepEqual(result.filters, { single: filters.single, multi: filters.multi, range: filters.range });
  assert.equal(filters.choice.value.length, 2, "input is never mutated");
});
