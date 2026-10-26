import test from "node:test";
import assert from "node:assert/strict";
import { exhibitionOf, exhibitionSelectionPayload, hasExhibitionHolds, lineRequiresExhibition, withExhibitionSelection } from "./exhibition.js";
import { CATALOGUE_FIELDS, catalogueCopyForEditing } from "../../pages/sales/catalogueProductForm.js";

const first = { slotKey: "slot-a", spaceId: "space-a", reference: "EX-17", priceMinor: 17350, currency: "GBP" };
const second = { slotKey: "slot-b", spaceId: "space-b", reference: "EX-18", priceMinor: 21175, currency: "GBP" };
const line = { key: "line-db", persistedLineId: "line-db", type: "bundle", quantity: 3, quotedUnitPriceMinor: 59825, catalogue_snapshot: { exhibition: { lineKey: "logical-line", slots: [{ key: "slot-a", logicalLineId: "logical-line" }, { key: "slot-b" }], selections: [first, second] } } };
const form = { id: "quote", eventId: "event", notes: "Keep customer edits", rowVersion: 7, lines: [line, { key: "other", quantity: 2 }] };

test("omitted selections preserve holds while explicit empty selections clear them", () => {
  assert.deepEqual(exhibitionSelectionPayload(line), {});
  assert.deepEqual(exhibitionSelectionPayload({ ...line, exhibitionSelections: [] }), { exhibitionSelections: [] });
  assert.equal(hasExhibitionHolds(form), true);
  assert.equal(exhibitionOf(line).lineKey, "logical-line");
});

test("replacement is immutable, preserves the entire draft and retains other slots' exact identities", () => {
  const next = withExhibitionSelection(form, "line-db", "slot-a", "space-new");
  assert.deepEqual(next.lines[0].exhibitionSelections, [{ slotKey: "slot-b", spaceId: "space-b" }, { slotKey: "slot-a", spaceId: "space-new" }]);
  assert.equal(next.notes, form.notes);
  assert.equal(next.lines[0].quotedUnitPriceMinor, 59825);
  assert.equal(next.lines[0].quantity, 3);
  assert.equal(next.lines[1], form.lines[1]);
  assert.deepEqual(line.catalogue_snapshot.exhibition.selections, [first, second]);
  assert.deepEqual(exhibitionSelectionPayload(next.lines[0]), { exhibitionSelections: next.lines[0].exhibitionSelections });
});

test("clear removes only the targeted slot and repeated overrides compose without leaking snapshot fields", () => {
  const next = withExhibitionSelection(form, "line-db", "slot-a", null);
  const cleared = withExhibitionSelection(next, "line-db", "slot-b", null);
  assert.deepEqual(cleared.lines[0].exhibitionSelections, []);
  assert.deepEqual(exhibitionSelectionPayload(cleared.lines[0]), { exhibitionSelections: [] });
});

test("new products and included bundle components announce save-first space requirements", () => {
  const products = [{ id: "stand", spaceRequirementId: "requirement" }, { id: "ticket", eventReference: { eventId: "event", ticketTypeId: "ticket" } }];
  const bundles = [{ id: "sponsor", sellingPriceMinor: 88325, items: [{ productId: "stand", quantity: 2 }] }];
  assert.equal(lineRequiresExhibition({ type: "product", productId: "stand" }, products, bundles), true);
  assert.equal(lineRequiresExhibition({ type: "bundle", bundleId: "sponsor" }, products, bundles), true);
  assert.equal(lineRequiresExhibition({ type: "product", productId: "ticket" }, products, bundles), false);
  assert.equal(lineRequiresExhibition(line), true);
  assert.equal(lineRequiresExhibition({ type: "free_text" }), false);
});

test("product create/edit/copy whitelist preserves requirements without changing ticket references", () => {
  const eventReference = { kind: "complex", eventId: "ticket-event", ticketTypeId: "ticket-type" };
  assert.ok(CATALOGUE_FIELDS.products.includes("spaceRequirementId"));
  const copy = catalogueCopyForEditing("products", { name: "Exhibitor", spaceRequirementId: "requirement-id", eventReference }, "COPY-EX");
  assert.equal(copy.spaceRequirementId, "requirement-id");
  assert.deepEqual(copy.eventReference, eventReference);
  const cleared = catalogueCopyForEditing("products", { name: "Exhibitor", spaceRequirementId: null }, "COPY-NO");
  assert.equal(cleared.spaceRequirementId, null);
});
