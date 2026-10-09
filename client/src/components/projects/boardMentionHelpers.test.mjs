import { test } from "node:test";
import assert from "node:assert/strict";
import { availableInboxCard, boardMentionOptions, inboxCardError, insertMention, mentionIdentityIds, mentionLabel, mentionTrigger, retainedMentions } from "./boardMentionHelpers.mjs";

const members = [
  { identity_id: "mia", first_name: "Mia", last_name: "Chen", email: "mia@example.test" },
  { identity_id: "jules", first_name: "Jules", last_name: "Le Roy", email: "jules@example.test" },
  { identity_id: "email", email: "sam@example.test" },
];
test("literal tenant names and email fallback, only explicit current board memberships", () => {
  assert.equal(mentionLabel(members[1]), "Jules Le Roy");
  assert.equal(mentionLabel(members[2]), "sam@example.test");
  assert.deepEqual(boardMentionOptions([...members, members[0], { identity_id: "nameless" }]).map((item) => item.id), ["mia", "jules", "email"]);
  assert.deepEqual(mentionIdentityIds("Hi @Mia Chen", [], members), []);
  assert.deepEqual(mentionIdentityIds("Hi @Mia Chen", [{ id: "outsider", label: "Mia Chen" }], members), []);
});
test("deduplication, removal, membership and name changes", () => {
  const picked = [{ id: "mia", label: "Mia Chen" }, { id: "mia", label: "Mia Chen" }, { id: "jules", label: "Jules Le Roy" }];
  assert.deepEqual(mentionIdentityIds("@Mia Chen @Mia Chen @Jules Le Roy", picked, members), ["mia", "jules"]);
  assert.deepEqual(mentionIdentityIds("@Mia Che @Jules Le Roy", picked, members), ["jules"]);
  assert.deepEqual(retainedMentions("@Mia Chen", picked, members.filter((item) => item.identity_id !== "mia")), []);
  assert.deepEqual(retainedMentions("@Mia Chen", picked, [{ ...members[0], last_name: "Ortiz" }]), []);
});
test("autocomplete at caret supports full names, avoids emails, and preserves suffix", () => {
  assert.equal(mentionTrigger("Email mia@example.test", 22), null);
  assert.deepEqual(mentionTrigger("Hi @Jules Le", 12), { start: 3, end: 12, query: "Jules Le" });
  const content = "Hi @Mi, please review.";
  const result = insertMention(content, mentionTrigger(content, 6), boardMentionOptions(members)[0]);
  assert.equal(result.content, "Hi @Mia Chen , please review.");
  assert.equal(result.caret, 13);
  assert.equal(mentionTrigger("Hi @Mia\nNext line", 17), null);
});
test("card opening rejects unavailable and moved cards; API permission errors are clear", () => {
  const card = { id: "card", board_id: "board" };
  assert.equal(availableInboxCard({ card }, "board"), card);
  for (const result of [{}, { card: { ...card, archived_at: "2026-01-01" } }, { card: { ...card, is_archived: true } }, { card: { ...card, deleted_at: "2026-01-01" } }]) {
    assert.throws(() => availableInboxCard(result, "board"), /deleted or archived/);
  }
  assert.throws(() => availableInboxCard({ card }, "other-board"), /no longer on this board/);
  assert.match(inboxCardError({ status: 403 }), /no longer have access/);
  assert.match(inboxCardError({ status: 404 }), /deleted or archived/);
  assert.match(inboxCardError({ status: 410 }), /deleted or archived/);
});
