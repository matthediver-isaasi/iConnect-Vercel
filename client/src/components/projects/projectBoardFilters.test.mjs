import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSIGNED_TO_ME, UNASSIGNED, emptyBoardFilters, filterBoardCards,
  filteredInsertionPosition, groupBoardCards, normalizeSearchDocuments,
} from "./projectBoardFilters.mjs";

const card = (id, position, patch = {}) => ({
  id, position, list_id: "work", title: id, description: "",
  project_card_label: [], project_card_assignee: [], ...patch,
});
const cards = [
  card("a", 0, { title: "Membership [review]", project_card_label: [{ label_id: "red" }], project_card_assignee: [{ identity_id: "me" }, { identity_id: "other" }] }),
  card("b", 1, { description: "Renewal summary", project_card_label: [{ label_id: "blue" }], is_complete: true }),
  card("c", 2, { project_card_label: [{ label_id: "red" }], project_card_assignee: [{ identity_id: "other" }] }),
  card("d", 3),
];
const ids = items => items.map(item => item.id);
const filter = (patch, documents) => filterBoardCards(cards, { ...emptyBoardFilters(), ...patch }, "me", documents);

test("defaults preserve all cards and combinations are OR within / AND across types", () => {
  assert.deepEqual(ids(filter({})), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(filter({ labels: ["red", "blue"] })), ["a", "b", "c"]);
  assert.deepEqual(ids(filter({ assignees: [ASSIGNED_TO_ME] })), ["a"]);
  assert.deepEqual(ids(filter({ assignees: [UNASSIGNED] })), ["b", "d"]);
  assert.deepEqual(ids(filter({ assignees: [ASSIGNED_TO_ME, UNASSIGNED] })), ["a", "b", "d"]);
  assert.deepEqual(ids(filter({ assignees: ["other"] })), ["a", "c"]);
  assert.deepEqual(ids(filter({ labels: ["red", "blue"], assignees: [ASSIGNED_TO_ME, UNASSIGNED], hideCompleted: true, keyword: "review" })), ["a"]);
  assert.deepEqual(filterBoardCards(cards, { ...emptyBoardFilters(), assignees: [ASSIGNED_TO_ME] }, undefined), []);
});

test("literal, case-insensitive partial search includes description, comments and activity", () => {
  const documents = normalizeSearchDocuments([
    { cardId: "c", text: "Comment: Invoice adjustment requested" },
    { cardId: "d", text: "Activity: Received sponsor confirmation" },
  ]);
  assert.deepEqual(ids(filter({ keyword: "  [REVIEW] " }, documents)), ["a"]);
  assert.deepEqual(ids(filter({ keyword: "ewal sum" }, documents)), ["b"]);
  assert.deepEqual(ids(filter({ keyword: "VOICE ADJ" }, documents)), ["c"]);
  assert.deepEqual(ids(filter({ keyword: "sponsor" }, documents)), ["d"]);
  assert.deepEqual(ids(filter({ keyword: ".*" }, documents)), []);
  const changed = { ...cards[2], title: "Fresh client title" };
  assert.deepEqual(ids(filterBoardCards([changed], { ...emptyBoardFilters(), keyword: "fresh" }, "me", documents)), ["c"]);
});

test("filters and grouping never mutate cards or nested assignments", () => {
  const original = JSON.stringify(cards);
  filter({ hideCompleted: true, labels: ["red"] });
  assert.deepEqual(ids(groupBoardCards([...cards].reverse()).get("work")), ["a", "b", "c", "d"]);
  assert.equal(JSON.stringify(cards), original);
});

test("filtered insertion preserves leading, middle and trailing hidden cards", () => {
  const full = ["h0", "v1", "h2", "v3", "h4"].map((id, i) => card(id, i));
  const visible = full.filter(item => item.id.startsWith("v"));
  assert.equal(filteredInsertionPosition(full, visible, "external", 0), 1);
  assert.equal(filteredInsertionPosition(full, visible, "external", 1), 3);
  assert.equal(filteredInsertionPosition(full, visible, "external", 2), 4);
  assert.equal(filteredInsertionPosition(full, [], "external", 0), 5);
  assert.equal(filteredInsertionPosition([], [], "external", 0), 0);
  assert.equal(filteredInsertionPosition(full, visible, "v1", 1), 3);
  assert.equal(filteredInsertionPosition(full, visible, "v3", 0), 1);
  const position = filteredInsertionPosition(full, visible, "v1", 1);
  const moved = full.filter(item => item.id !== "v1");
  moved.splice(position, 0, full[1]);
  assert.deepEqual(ids(moved), ["h0", "h2", "v3", "v1", "h4"]);
  assert.deepEqual(ids(moved.filter(item => item.id.startsWith("h"))), ["h0", "h2", "h4"]);
  assert.equal(filteredInsertionPosition(cards, cards, "a", 2), 2);
});
