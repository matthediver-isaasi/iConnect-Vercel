import test from "node:test";
import assert from "node:assert/strict";
import { MEMBER_GROUP_MEASURES, changeGroupMeasure, groupFieldCompatible, groupHistoryNotice } from "./memberGroupReporting.js";
import { describeWidgetConfig } from "../../../../shared/widgetDescriber.js";

test("all four metric selections serialize with the count contract and reset incompatible state", () => {
  for (const { field } of MEMBER_GROUP_MEASURES) {
    const next = changeGroupMeasure({ source: "member_group", groupBy: { field: "role_id" }, filters: [{ field: "role_id" }], cumulative: true, clickThrough: true }, field);
    assert.deepEqual(next.measure, { aggregator: "count", fieldKind: "system", field, fieldId: null });
    assert.equal(next.clickThrough, false);
    assert.equal(next.cumulative, false);
    assert.equal(next.groupBy, null);
    assert.deepEqual(next.filters, []);
    const reopened = JSON.parse(JSON.stringify(next));
    assert.deepEqual(reopened, next);
    assert.equal(reopened.timeBucket?.field || null, ["joins", "period_end_members"].includes(field) ? "membership_at" : null);
  }
});

test("group dimensions exclude measure/date fields and member dimensions for group counts", () => {
  for (const usage of ["group", "filter"]) {
    assert.equal(groupFieldCompatible({ field: "group_id" }, "groups", usage), true);
    assert.equal(groupFieldCompatible({ field: "group_role" }, "groups", usage), false);
    assert.equal(groupFieldCompatible({ fieldKind: "custom", fieldId: "tenant-field" }, "groups", usage), false);
    assert.equal(groupFieldCompatible({ field: "groups" }, "current_members", usage), false);
    assert.equal(groupFieldCompatible({ field: "membership_at" }, "joins", usage), false);
    assert.equal(groupFieldCompatible({ field: "group_role" }, "joins", usage), true);
    assert.equal(groupFieldCompatible({ fieldKind: "custom", fieldId: "tenant-field" }, "period_end_members", usage), true);
  }
  assert.equal(groupFieldCompatible({ field: "membership_at" }, "current_members", "date"), false);
  assert.equal(groupFieldCompatible({ field: "membership_at" }, "joins", "date"), true);
});

test("missing history and provisional periods have explicit labels; known zero is not unavailable", () => {
  assert.equal(groupHistoryNotice({ rows: [{ key: "known", value: 0 }] }), "");
  const notice = groupHistoryNotice({ rows: [{ key: "old", value: null }, { key: "now", value: 3, provisional: true }] });
  assert.match(notice, /Unavailable history: old/);
  assert.match(notice, /Missing history is not zero/);
  assert.match(notice, /Current \/ provisional: now/);
});

test("describer distinguishes group counts, current headcounts, joins and period-end totals", () => {
  const describe = field => describeWidgetConfig({ source: "member_group", measure: { aggregator: "count", field }, seriesBy: { field: "group_id" } });
  assert.match(describe("groups"), /including empty groups/);
  assert.match(describe("current_members"), /must not be added/);
  assert.match(describe("joins"), /Baseline memberships are not new joins/);
  assert.match(describe("period_end_members"), /not joins or cumulative joins/);
  assert.match(describe("period_end_members"), /provisional/);
  assert.match(describe("period_end_members"), /unavailable/);
  assert.match(describe("period_end_members"), /Historical filters use CURRENT member attributes/);
  assert.match(describe("period_end_members"), /Deleted members remain in unfiltered historical headcounts but have no current attributes/);
  assert.match(describe("period_end_members"), /Group names and active state use the latest recorded values/);
  assert.match(describe("current_members"), /Hidden and login-disabled members remain eligible/);
  assert.match(describe("current_members"), /Guest assignments are excluded/);
});