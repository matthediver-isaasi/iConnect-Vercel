import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activeSessionCategories, resolveSessionCategories, sessionCategoryIds } from "./sessionCategories.js";

const catalogue = [
  { id: "resources", name: "Research", is_active: true, display_order: 9, applies_to_content_types: ["Resources"] },
  { id: "inactive", name: "Retired", is_active: false, display_order: 0 },
  { id: "events", name: "Practice", is_active: true, display_order: 2, applies_to_content_types: ["Events"] },
];

test("active catalogue includes all content types in display order without mutating input", () => {
  assert.deepEqual(activeSessionCategories(catalogue).map(c => c.id), ["events", "resources"]);
  assert.equal(catalogue[0].id, "resources");
});

test("assignment IDs survive unavailable, loading and failed catalogues", () => {
  const ids = ["resources", "deleted", "inactive"];
  assert.deepEqual(resolveSessionCategories(ids, catalogue), [
    { id: "resources", name: "Research" },
    { id: "deleted", name: "Unavailable category", unavailable: true },
    { id: "inactive", name: "Unavailable category", unavailable: true },
  ]);
  assert.deepEqual(resolveSessionCategories(ids, undefined, { settled: false }).map(c => c.id), ids);
  assert.ok(resolveSessionCategories(ids, undefined, { settled: false }).every(c => c.name === "Saved category"));
  assert.deepEqual(ids, ["resources", "deleted", "inactive"]);
  assert.deepEqual(sessionCategoryIds(ids.filter(id => id !== "deleted")), ["resources", "inactive"]);
});

test("empty, invalid and duplicate assignment IDs are normalized without catalogue pruning", () => {
  assert.deepEqual(sessionCategoryIds(undefined), []);
  assert.deepEqual(sessionCategoryIds(["a", "a", null, 5, "", "missing"]), ["a", "missing"]);
  assert.deepEqual(resolveSessionCategories(["missing"], catalogue, { unavailable: false }), []);
});

test("editor carries IDs through every default, hydration, local save and dedicated session payload", () => {
  const source = readFileSync(new URL("../pages/CreateComplexEvent.jsx", import.meta.url), "utf8");
  assert.equal((source.match(/category_ids: \[\]/g) || []).length, 2);
  assert.match(source, /category_ids: sessionCategoryIds\(s.category_ids\)/);
  assert.match(source, /setSessionForm\(\{[\s\S]*?category_ids: sessionCategoryIds\(session.category_ids\)/);
  assert.match(source, /s\._localId === editingSession \? \{ \.\.\.s, \.\.\.sessionForm \}/);
  assert.match(source, /\{ \.\.\.sessionForm, _localId: generateId\(\)/);
  assert.match(source, /const sessionPayload = \{[\s\S]*?category_ids: sessionCategoryIds\(session.category_ids\)/);
});

test("public views use only server-visible labels, including the session details dialog", () => {
  const source = readFileSync(new URL("../components/events/ComplexEventSchedule.jsx", import.meta.url), "utf8");
  assert.equal((source.match(/<SessionCategoryBadges categories=\{session.categories\}/g) || []).length, 2);
  assert.doesNotMatch(source, /category_ids|ResourceCategory/);
  assert.match(source, /overflow-y-auto/);
  assert.doesNotMatch(source, /categories=\{session.categories\} compact/);
});
