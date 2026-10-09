import test from "node:test";
import assert from "node:assert/strict";
import { inboxActionBody, inboxBulkBody, inboxDetailPath, inboxMessageKey, inboxSearchKeys, invalidateInboxViews, projectInboxCardUrl, splitInboxSelection } from "./inboxSources.mjs";
import { availableInboxCard } from "../components/projects/boardMentionHelpers.mjs";

const messages = [
  { recipient_id: "same-id", source: "group" },
  { recipient_id: "same-id", source: "transactional" },
  { recipient_id: "same-id", source: "project", board_id: "board/a", card_id: "card?b" },
];

test("mixed selections keep colliding IDs separate for every supported action", () => {
  const map = new Map(messages.map((message) => [inboxMessageKey(message), message]));
  assert.equal(map.size, 3);
  const { campaign, transactional, project } = splitInboxSelection([...map.keys(), "stale"], map);
  for (const action of ["read", "unread", "pin", "unpin", "archive", "unarchive", "favourite", "unfavourite", "move"]) {
    assert.deepEqual(inboxBulkBody(campaign, transactional, action, "folder", project), {
      action, folder_id: "folder", recipient_ids: ["same-id"], transactional_ids: ["same-id"], project_ids: ["same-id"],
    });
    assert.deepEqual(inboxActionBody("same-id", action, null, "project"), { action, folder_id: null, project_id: "same-id" });
  }
});

test("legacy bulk signature and campaign detail routes are unchanged", () => {
  assert.deepEqual(inboxBulkBody(["campaign"], ["transaction"], "archive"), {
    action: "archive", folder_id: undefined, recipient_ids: ["campaign"], transactional_ids: ["transaction"],
  });
  assert.equal(inboxBulkBody([], [], "read"), null);
  assert.deepEqual(inboxBulkBody([], [], "move", null, ["mention"]), { action: "move", folder_id: null, project_ids: ["mention"] });
  assert.deepEqual(inboxActionBody("c", "read", undefined, "group"), { action: "read", folder_id: undefined, recipient_id: "c" });
  assert.equal(inboxDetailPath("id", "announcement"), "/api/communication/inbox/id");
  assert.equal(inboxDetailPath("id", "transactional"), "/api/communication/inbox/id?source=transactional");
  assert.equal(inboxDetailPath("a/b", "project"), "/api/communication/inbox/a%2Fb?source=project");
});

test("body search is source-aware, including legacy and qualified results", () => {
  assert.deepEqual(inboxSearchKeys({ recipientIds: ["same-id"], transactionalIds: ["same-id"], projectIds: ["same-id"] }), messages.map(inboxMessageKey));
  assert.deepEqual(inboxSearchKeys({ recipientIds: ["project:same-id", { source: "transactional", recipient_id: "same-id" }] }), ["project:same-id", "transactional:same-id"]);
  assert.deepEqual(inboxSearchKeys({ matches: [{ source: "project", id: "m" }] }), ["project:m"]);
  assert.deepEqual(inboxSearchKeys({}), []);
  assert.deepEqual(inboxSearchKeys({ recipientIds: ["same-id"] }, [messages[2]]), ["project:same-id"]);
  assert.deepEqual(inboxSearchKeys({ recipientIds: ["same-id"] }, [messages[1]]), ["transactional:same-id"]);
});

test("Open card links encode identifiers and fail closed for moved, missing and archived cards", () => {
  assert.equal(projectInboxCardUrl(messages[2]), "/ProjectBoard/board%2Fa?cardId=card%3Fb");
  assert.equal(projectInboxCardUrl(messages[0]), null);
  assert.equal(projectInboxCardUrl({ source: "project", board_id: "b" }), null);
  assert.throws(() => availableInboxCard({ card: { id: "c" } }, "b"), /no longer on this board/);
  assert.throws(() => availableInboxCard({ card: { id: "c", board_id: "other" } }, "b"), /no longer on this board/);
  assert.throws(() => availableInboxCard({ card: { id: "c", board_id: "b", is_archived: true } }, "b"), /archived/);
});

test("mutual invalidation refreshes both inboxes and search/badge, never auto-read detail", async () => {
  const calls = [];
  await invalidateInboxViews({ invalidateQueries: async (options) => calls.push(options) });
  assert.deepEqual(calls, [
    { queryKey: ["inbox"], exact: true },
    { queryKey: ["inbox", "unread"], exact: true },
    { queryKey: ["inbox", "search"] },
    { queryKey: ["board-inbox"] },
  ]);
});
