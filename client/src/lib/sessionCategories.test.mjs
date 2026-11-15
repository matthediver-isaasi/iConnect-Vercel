import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activeSessionCategories, groupSessionCategories, resolveSessionCategories, sessionCategoryIds } from "./sessionCategories.js";

const catalogue = [
  { id: "resources:Research", name: "Research", category_id: "resources", category_name: "Professional learning", is_active: true, display_order: 9, applies_to_content_types: ["Resources"] },
  { id: "resources:Retired", name: "Retired", category_id: "resources", category_name: "Professional learning", is_active: false, display_order: 0 },
  { id: "events:Practice", name: "Practice", category_id: "events", category_name: "Clinical", is_active: true, display_order: 2, applies_to_content_types: ["Events"] },
];

test("active catalogue includes all content types in display order without mutating input", () => {
  assert.deepEqual(activeSessionCategories(catalogue).map(c => c.id), ["events:Practice", "resources:Research"]);
  assert.equal(catalogue[0].id, "resources:Research");
});

test("subcategory keys survive unavailable, loading and failed catalogues", () => {
  const ids = ["resources:Research", "deleted:Hidden", "resources:Retired"];
  assert.deepEqual(resolveSessionCategories(ids, catalogue), [
    { id: "resources:Research", name: "Research", category_name: "Professional learning" },
    { id: "deleted:Hidden", name: "Unavailable subcategory", unavailable: true },
    { id: "resources:Retired", name: "Unavailable subcategory", unavailable: true },
  ]);
  assert.deepEqual(resolveSessionCategories(ids, undefined, { settled: false }).map(c => c.id), ids);
  assert.ok(resolveSessionCategories(ids, undefined, { settled: false }).every(c => c.name === "Saved subcategory"));
  assert.deepEqual(ids, ["resources:Research", "deleted:Hidden", "resources:Retired"]);
  assert.deepEqual(sessionCategoryIds(ids.filter(id => id !== "deleted:Hidden")), ["resources:Research", "resources:Retired"]);
});

test("empty, invalid and duplicate assignment IDs are normalized without catalogue pruning", () => {
  assert.deepEqual(sessionCategoryIds(undefined), []);
  assert.deepEqual(sessionCategoryIds(["a", "a", null, 5, "", "missing"]), ["a", "missing"]);
  assert.deepEqual(resolveSessionCategories(["missing"], catalogue, { unavailable: false }), []);
});

test("grouping excludes parents and inactive children and keeps same-named parents separate", () => {
  const rows = [
    ...catalogue,
    { id: "parent-only", name: "Not selectable" },
    { ...catalogue[0], id: "resources:Guidance", name: "Guidance", display_order: 10 },
    { ...catalogue[0], id: "another:Research", category_id: "another", display_order: 11 },
  ];
  const groups = groupSessionCategories(rows);
  assert.deepEqual(groups.map(group => group.id), ["events", "resources", "another"]);
  assert.deepEqual(groups[1].children.map(child => child.name), ["Research", "Guidance"]);
  assert.equal(groups[1].name, groups[2].name);
  assert.deepEqual(groupSessionCategories(undefined), []);
});

test("editor carries only subcategory keys through defaults, hydration, local save and dedicated payload", () => {
  const source = readFileSync(new URL("../pages/CreateComplexEvent.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /category_ids/);
  assert.equal((source.match(/subcategory_keys: \[\]/g) || []).length, 2);
  assert.match(source, /subcategory_keys: sessionCategoryIds\(s.subcategory_keys\)/);
  assert.match(source, /setSessionForm\(\{[\s\S]*?subcategory_keys: sessionCategoryIds\(session.subcategory_keys\)/);
  assert.match(source, /s\._localId === editingSession \? \{ \.\.\.s, \.\.\.sessionForm \}/);
  assert.match(source, /\{ \.\.\.sessionForm, _localId: generateId\(\)/);
  assert.match(source, /const sessionPayload = \{[\s\S]*?subcategory_keys: sessionCategoryIds\(session.subcategory_keys\)/);
  assert.match(source, /categories: resolveSessionCategories\(session.subcategory_keys, sessionCategoriesQuery.data/);
  assert.match(source, /value=\{sessionForm.subcategory_keys\}/);
  assert.match(source, /onChange=\{subcategory_keys => setSessionForm\(prev => \(\{ \.\.\.prev, subcategory_keys \}\)\)\}/);
});

test("public views use only server-visible labels, including the session details dialog", () => {
  const source = readFileSync(new URL("../components/events/ComplexEventSchedule.jsx", import.meta.url), "utf8");
  assert.equal((source.match(/<SessionCategoryBadges categories=\{session.categories\}/g) || []).length, 2);
  assert.doesNotMatch(source, /category_ids|ResourceCategory/);
  assert.match(source, /overflow-y-auto/);
  assert.doesNotMatch(source, /categories=\{session.categories\} compact/);
});
