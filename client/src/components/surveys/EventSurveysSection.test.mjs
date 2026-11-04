import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { assignmentIsRemoved, surveyAssignmentCardClass } from "../../lib/surveyLifecycle.js";

test("card colours follow survey lifecycle, with removed assignments taking precedence", () => {
  const active = { survey_settings: { lifecycle_state: "active" } };
  const draft = { survey_settings: { lifecycle_state: "draft" } };
  assert.match(surveyAssignmentCardClass(active, { status: "active" }), /bg-green-50/);
  assert.match(surveyAssignmentCardClass(draft, { status: "active" }), /bg-yellow-50/);
  for (const status of ["removed", "archived"]) {
    for (const form of [active, draft, undefined]) {
      assert.match(surveyAssignmentCardClass(form, { status }), /bg-red-50/);
    }
  }
  for (const state of ["paused", "closed", "archived"]) {
    assert.match(surveyAssignmentCardClass({ survey_settings: { lifecycle_state: state } }, { status: "active" }), /bg-slate-50/);
  }
  assert.match(surveyAssignmentCardClass(undefined, { status: "active" }), /bg-white/);
});

test("actual component filter hides retained removals by default and reveals them without modifying data", async () => {
  const source = readFileSync("client/src/components/surveys/EventSurveysSection.jsx", "utf8");
  assert.match(source, /\[showRemoved, setShowRemoved\] = useState\(false\)/);
  const expression = source.match(/const visibleAssignments = (.*);/)[1];
  const filter = new Function("assignments", "showRemoved", "assignmentIsRemoved", `return ${expression}`);
  const rows = Object.freeze(["active", "removed", "archived"].map(status => Object.freeze({ status })));
  assert.deepEqual(filter(rows, false, assignmentIsRemoved), [rows[0]]);
  assert.deepEqual(filter(rows, true, assignmentIsRemoved), rows);
  assert.match(source, /onChange=\{event => setShowRemoved\(event.target.checked\)\}/);
  assert.match(source, /visibleAssignments\.map/);
  assert.match(source, /No surveys currently attached/);
  assert.match(source, /Reattach to Event/);
  await transform(source, { loader: "jsx", jsx: "automatic" });
});
