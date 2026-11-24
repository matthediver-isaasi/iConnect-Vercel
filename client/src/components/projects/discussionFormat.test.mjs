import test from "node:test";
import assert from "node:assert/strict";
import { discussionText, groupDiscussion, safeDiscussionUrl, DISCUSSION_EMOJIS, mergeDiscussionDetails, legacyDiscussionDoc } from "./discussionFormat.mjs";

test("legacy comment text is preserved as text and rich documents project readable content", () => {
  assert.equal(discussionText({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Decision", marks: [{ type: "bold" }] }] },
      { type: "paragraph", content: [{ type: "mention", attrs: { id: "member-a", label: "Maya Stone" } }] },
      { type: "paragraph", content: [{ type: "commentImage", attrs: { attachmentId: "private-attachment" } }] },
    ],
  }), "Decision\n@Maya Stone");
  assert.equal(discussionText("literal <img src=x> stays literal"), "literal <img src=x> stays literal");
});

test("safe discussion URLs permit only explicit web and mail links", () => {
  assert.equal(safeDiscussionUrl("https://example.test/a"), "https://example.test/a");
  assert.equal(safeDiscussionUrl("mailto:team@example.test"), "mailto:team@example.test");
  for (const value of [
    "javascript:alert(1)", "data:text/html,hello", "//example.test", "file:///etc/passwd",
    "https://user:secret@example.test", "https://example.test/contains space", "https://example.test/\npath",
  ]) {
    assert.equal(safeDiscussionUrl(value), null, value);
  }
});

test("older detail reads keep the newest discussion snapshot without blocking other card fields", () => {
  const stale = mergeDiscussionDetails(
    { discussionVersion: 8, comments: [{ id: "new" }], card: { title: "previous" } },
    { discussionVersion: 6, comments: [{ id: "old" }], discussionCanWrite: false, card: { title: "fresh task field" } },
  );
  assert.equal(stale.discussionVersion, 8);
  assert.deepEqual(stale.comments, [{ id: "new" }]);
  assert.deepEqual(stale.card, { title: "fresh task field" });
  assert.equal(stale.discussionCanWrite, false, "the incoming current permission is never hidden by a stale discussion version");
  const fresh = mergeDiscussionDetails(stale, { discussionVersion: 9, comments: [{ id: "newest" }], card: { title: "next" } });
  assert.deepEqual(fresh.comments, [{ id: "newest" }]);
  assert.equal(fresh.discussionVersion, 9);
});

test("legacy edits restore only explicit mention nodes and attachment-backed image references", () => {
  const attachmentId = "11111111-2222-4333-8444-555555555555";
  const doc = legacyDiscussionDoc({
    content: "Review with @Maya Stone; literal @Other Person.",
    mentions: [{ id: "11111111-2222-4333-8444-555555555501", label: "Maya Stone" }],
    images: [{ attachment: { id: attachmentId, url: "https://signed.example/image" } }],
  });
  assert.deepEqual(doc.content[0].content.slice(0, 3), [
    { type: "text", text: "Review with " },
    { type: "mention", attrs: { id: "11111111-2222-4333-8444-555555555501", label: "Maya Stone" } },
    { type: "text", text: "; literal @Other Person." },
  ]);
  assert.deepEqual(doc.content[0].content.at(-1), { type: "commentImage", attrs: { attachmentId } });
  assert.equal(JSON.stringify(doc).includes("signed.example"), false);
});

test("flat replies group under the single-level root and the picker contains the requested six reactions", () => {
  const grouped = groupDiscussion([
    { id: "root", parent_comment_id: null },
    { id: "reply", parent_comment_id: "root" },
    { id: "reply-to-reply", parent_comment_id: "root", reply_to_comment_id: "reply" },
  ]);
  assert.deepEqual(grouped.map((item) => item.id), ["root"]);
  assert.deepEqual(grouped[0].replies.map((item) => item.id), ["reply", "reply-to-reply"]);
  assert.deepEqual(DISCUSSION_EMOJIS, ["👍", "❤️", "😂", "😮", "😢", "😊"]);
});
