import test from "node:test";
import assert from "node:assert/strict";
import { bundleItemsForSaving, catalogueCopyForEditing } from "./catalogueProductForm.js";
import { bundleItemLabel, groupsForEditing, groupsForSaving, suggestedGroupAmounts } from "../../components/sales/billingGroups.js";
import { bundlePreviewLines } from "../../components/sales/bundlePreview.js";

const reference = { kind: "event", eventId: "conference", ticketTypeId: "delegate" };
const ticket = () => ({ kind: "ticket", componentId: crypto.randomUUID(), eventReference: { ...reference }, quantity: 3 });
const group = (productIds, allocatedMinor = 12500) => ({
  id: "group", name: "Conference", productIds, allocatedMinor,
  timing: { kind: "acceptance", days: 0 }, paymentTerms: { id: "terms", name: "Fourteen days", days: 14 },
});

test("mixed items retain order, strict product payload and stable ticket UUID on repeated saves", () => {
  const component = ticket();
  const items = [{ productId: "stand", quantity: "2", editorCategory: "category:space" }, { ...component, quantity: "3", editorKey: "temporary" }, { productId: "lunch", quantity: 1 }];
  const expected = [{ productId: "stand", quantity: 2 }, component, { productId: "lunch", quantity: 1 }];
  assert.deepEqual(bundleItemsForSaving(items), expected);
  assert.deepEqual(bundleItemsForSaving(items), expected);
  assert.deepEqual(bundleItemsForSaving([...items].reverse()), [...expected].reverse());
});

test("all bundle quantities must be positive whole numbers and ticket references must be complete", () => {
  for (const quantity of [0, "", -1, 1.2, "NaN", Number.MAX_SAFE_INTEGER + 1]) {
    for (const item of [ticket(), { productId: "stand" }]) {
      assert.throws(() => bundleItemsForSaving([{ ...item, quantity }]), /positive whole quantity/);
    }
  }
  for (const key of ["kind", "eventId", "ticketTypeId"]) {
    assert.throws(() => bundleItemsForSaving([{ ...ticket(), eventReference: { ...reference, [key]: "" } }]), /event and ticket type/);
  }
  assert.throws(() => bundleItemsForSaving([{ ...ticket(), componentId: "" }]), /identity/);
  assert.throws(() => bundleItemsForSaving([{ productId: "", quantity: 1 }]), /Choose a product/);
});

test("copy refreshes every ticket identity and remaps only ticket billing memberships without mutating source", () => {
  const first = ticket(), second = ticket();
  const source = { id: "bundle", name: "Conference", sellingPriceMinor: 12500,
    items: [{ productId: "stand", quantity: 1 }, first, second],
    billingGroups: [group(["stand", first.componentId, second.componentId])] };
  const original = structuredClone(source);
  const copy = catalogueCopyForEditing("bundles", source, "COPY-CONFERENCE");
  assert.deepEqual(source, original);
  assert.deepEqual(copy.items[0], source.items[0]);
  for (const index of [1, 2]) {
    assert.notEqual(copy.items[index].componentId, source.items[index].componentId);
    assert.deepEqual(copy.items[index].eventReference, reference);
  }
  assert.notEqual(copy.items[1].componentId, copy.items[2].componentId);
  assert.deepEqual(copy.billingGroups[0].productIds, ["stand", copy.items[1].componentId, copy.items[2].componentId]);
  const saved = groupsForSaving(groupsForEditing(copy.billingGroups), copy.items, 12500, { copying: true });
  assert.deepEqual(saved[0].productIds, copy.billingGroups[0].productIds);
});

test("billing membership includes ticket identities, rejects stale/duplicate/unassigned tickets and never fabricates ticket prices", () => {
  const component = ticket();
  const items = [{ productId: "stand", quantity: 1 }, component];
  const groups = groupsForEditing([group(["stand", component.componentId])]);
  assert.deepEqual(groupsForSaving(groups, items, 12500)[0].productIds, ["stand", component.componentId]);
  for (const ids of [["stand"], ["stand", component.componentId, component.componentId], ["stand", "stale"]]) {
    assert.throws(() => groupsForSaving([{ ...groups[0], productIds: ids }], items, 12500), /exactly one/);
  }
  assert.throws(() => suggestedGroupAmounts(groups, items, [{ id: "stand", standardPriceMinor: 500 }], 12500), /manually/);
  assert.equal(bundleItemLabel(component), "Ticket / event / conference / delegate");
});

test("unsaved preview shows ticket label and quantity and preserves authoritative saved components", () => {
  const component = ticket();
  const bundles = [{ id: "bundle", items: [component, { productId: "stand", quantity: 1 }] }];
  const line = { type: "bundle", bundleId: "bundle", quantity: 2 };
  const preview = bundlePreviewLines([line], [{ id: "stand", name: "Exhibition stand" }], bundles, []);
  assert.deepEqual(preview[0].bundleComponents, [{ name: "Ticket", quantity: 3 }, { name: "Exhibition stand", quantity: 1, categoryName: "Uncategorised" }]);
  const saved = { ...line, catalogueId: "bundle", components: [{ name: "Saved ticket", quantity: 7 }] };
  assert.equal(bundlePreviewLines([saved], [], bundles, [])[0], saved);
});
