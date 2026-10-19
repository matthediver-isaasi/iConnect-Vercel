import test from "node:test";
import assert from "node:assert/strict";
import { billingScheduleOf, billingTimingText, groupsForEditing, groupsForSaving, suggestedGroupAmounts, percentageToBps, percentageInstalmentsForEditing, percentageInstalmentsForSaving } from "./billingGroups.js";
import { catalogueCopyForEditing } from "../../pages/sales/catalogueProductForm.js";

const term = { id: "terms", name: "Fourteen days", days: 14 };
test("percentage editing and serialization use exact basis points and require separate presets", () => {
  assert.equal(percentageToBps("33.33"), 3333);
  assert.equal(percentageToBps("0.01"), 1);
  for (const value of ["", "0", "100.01", "33.333", "1e2", "-1", "NaN"]) assert.throws(() => percentageToBps(value));
  const rows = [3333, 3333, 3334].map((percentageBps, index) => ({ id: `row-${index}`, name: `Instalment ${index}`, percentageBps, paymentTerms: term, issueDelayPreset: { id: "delay", name: "Acceptance", days: 0 } }));
  assert.deepEqual(percentageInstalmentsForSaving(percentageInstalmentsForEditing(rows)), rows);
  assert.throws(() => percentageInstalmentsForSaving([]), /at least one/);
  const edited = percentageInstalmentsForEditing(rows);
  edited[0].percentage = "33.32";
  assert.throws(() => percentageInstalmentsForSaving(edited), /exactly 100/);
  edited[0].issueDelayPreset = null;
  assert.throws(() => percentageInstalmentsForSaving(edited), /issue delay/);
});
const group = (id, productIds, allocatedMinor) => ({ id, name: id, position: 0, productIds, allocatedMinor, timing: { kind: "acceptance", days: 7 }, paymentTerms: term });

test("group editing uses exact decimals, validates membership and reconciles independent selling price", () => {
  const groups = groupsForEditing([group("travel", ["p1"], 29), group("space", ["p2"], 238719)]);
  const items = [{ productId: "p1", quantity: 1 }, { productId: "p2", quantity: 1 }];
  const saved = groupsForSaving(groups, items, 238748);
  assert.equal(saved[0].allocatedMinor, 29);
  assert.deepEqual(saved[1].paymentTerms, term);
  assert.equal(saved[1].position, 1);
  assert.throws(() => groupsForSaving(groups, items, 238749), /exactly/);
  assert.throws(() => groupsForSaving(groups, [...items, { productId: "p3" }], 238748), /exactly one/);
  assert.throws(() => groupsForSaving([{ ...groups[0], productIds: ["p1", "p2"] }, groups[1]], items, 238748), /exactly one/);
  assert.throws(() => groupsForSaving(groups, [items[0]], 238748), /memberships/);
});

test("group validation rejects invalid precision, incomplete terms and invalid issue dates", () => {
  const base = groupsForEditing([group("deposit", ["p"], 100)]);
  const save = changes => groupsForSaving([{ ...base[0], ...changes }], [{ productId: "p" }], 100);
  assert.throws(() => save({ allocatedAmount: "1.001" }), /decimal places/);
  assert.throws(() => save({ paymentTerms: null }), /payment terms/);
  assert.throws(() => save({ timing: { kind: "acceptance", days: -1 } }), /whole number/);
  assert.throws(() => save({ timing: { kind: "fixed", date: "2028-02-30" } }), /valid fixed/);
  assert.equal(save({ timing: { kind: "fixed", date: "2028-02-29" } })[0].timing.date, "2028-02-29");
});

test("suggestions allocate component value proportions and stable spare pennies without changing total", () => {
  const groups = [group("a", ["p1"], 0), group("b", ["p2"], 0), group("c", ["p3"], 0)];
  const items = [1, 2, 3].map(n => ({ productId: `p${n}`, quantity: 1 }));
  const zeros = items.map(item => ({ id: item.productId, standardPriceMinor: 0 }));
  assert.deepEqual(suggestedGroupAmounts(groups, items, zeros, 101), ["0.34", "0.34", "0.33"]);
  assert.deepEqual(suggestedGroupAmounts(groups, items, zeros.map(row => row.id === "p2" ? { ...row, standardPriceMinor: 187 } : row), 101), ["0.00", "1.01", "0.00"]);
  assert.deepEqual(suggestedGroupAmounts([groups[0]], items, zeros, Number.MAX_SAFE_INTEGER), ["90071992547409.91"]);
  assert.throws(() => suggestedGroupAmounts(groups, items, [], 101), /Unavailable prices are not treated as zero/);
});

test("bundle copies replace group IDs and omit invoice history while retaining all billing configuration", () => {
  const source = { id: "source-bundle", name: "Conference", sellingPriceMinor: 238719, items: [{ productId: "p", quantity: 2 }], billingGroups: [{ ...group("old-id", ["p"], 238719), timing: { kind: "fixed", date: "2028-04-17" }, issueDelayPreset: { id: "delay", name: "Week", days: 7 }, invoices: ["must not copy"] }] };
  const copy = catalogueCopyForEditing("bundles", source, "COPY-CONFERENCE");
  assert.notEqual(copy.billingGroups[0].id, source.billingGroups[0].id);
  assert.equal(copy.billingGroups[0].invoices, undefined);
  assert.equal(copy.copySourceId, "source-bundle");
  assert.equal(copy.billingGroups[0].sourceGroupId, "old-id");
  assert.deepEqual(copy.billingGroups[0].paymentTerms, term);
  assert.deepEqual(copy.billingGroups[0].timing, source.billingGroups[0].timing);
  assert.deepEqual(copy.billingGroups[0].issueDelayPreset, source.billingGroups[0].issueDelayPreset);
  const formGroups = groupsForEditing(copy.billingGroups);
  const createPayloadGroups = groupsForSaving(formGroups, copy.items, 238719, { copying: true });
  assert.equal(createPayloadGroups[0].sourceGroupId, "old-id");
  assert.notEqual(createPayloadGroups[0].id, "old-id");
  const editPayloadGroups = groupsForSaving(formGroups, copy.items, 238719);
  assert.equal(editPayloadGroups[0].sourceGroupId, undefined, "Normal saves must not submit copy provenance");
  assert.equal(editPayloadGroups[0].invoices, undefined);
  copy.billingGroups[0].productIds.push("new");
  assert.deepEqual(source.billingGroups[0].productIds, ["p"]);
});

test("schedule readers accept camel and snake snapshots and show relative timing before acceptance", () => {
  const schedule = { groups: [{ id: "g" }] };
  assert.equal(billingScheduleOf({ currentVersion: { billing_schedule: schedule } }), schedule);
  assert.equal(billingScheduleOf({ billingSchedule: schedule }), schedule);
  assert.equal(billingTimingText({ kind: "acceptance", days: 0 }), "Issue on acceptance");
  assert.equal(billingTimingText({ kind: "acceptance", days: 14 }), "Issue 14 calendar days after acceptance");
  assert.equal(billingTimingText({ kind: "fixed", date: "2028-04-17" }), "Issue on 2028-04-17");
});
