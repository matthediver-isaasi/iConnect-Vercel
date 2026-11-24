export const DISCUSSION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "😊"];

export function safeDiscussionUrl(value = "") {
  const url = String(value).trim();
  if (!url || url.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) return null;
    if (parsed.protocol === "mailto:") return parsed.pathname ? url : null;
    return parsed.hostname && !parsed.username && !parsed.password ? url : null;
  } catch { return null; }
}

export function mergeDiscussionDetails(oldData, incoming) {
  if (oldData && Number.isFinite(Number(oldData.discussionVersion)) &&
    Number.isFinite(Number(incoming?.discussionVersion)) &&
    Number(incoming.discussionVersion) < Number(oldData.discussionVersion)) {
    return { ...incoming, comments: oldData.comments, discussionVersion: oldData.discussionVersion };
  }
  return incoming;
}

export function discussionText(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  const walk = (node) => {
    if (!node) return "";
    if (node.type === "text") return node.text || "";
    if (node.type === "mention") return `@${node.attrs?.label || ""}`;
    if (node.type === "hardBreak") return "\n";
    if (node.type === "commentImage") return "";
    const content = (node.content || []).map(walk).join("");
    return ["paragraph", "heading", "listItem", "blockquote"].includes(node.type) ? `${content}\n` : content;
  };
  return walk(doc).replace(/\n+$/, "");
}

export function legacyDiscussionDoc(comment = {}) {
  const collectImages = (node, ids = []) => {
    if (node?.type === "commentImage" && node.attrs?.attachmentId) ids.push(String(node.attrs.attachmentId));
    (node?.content || []).forEach((child) => collectImages(child, ids));
    return ids;
  };
  const textNodes = (line, mentions) => {
    const nodes = [];
    let cursor = 0;
    while (cursor < line.length) {
      const found = mentions.flatMap((mention) => {
        const token = `@${mention.label}`;
        const index = line.indexOf(token, cursor);
        return index >= 0 && (index === 0 || /\s/.test(line[index - 1]))
          ? [{ mention, token, index }] : [];
      }).sort((a, b) => a.index - b.index || b.token.length - a.token.length)[0];
      if (!found) {
        if (cursor < line.length) nodes.push({ type: "text", text: line.slice(cursor) });
        break;
      }
      if (found.index > cursor) nodes.push({ type: "text", text: line.slice(cursor, found.index) });
      nodes.push({ type: "mention", attrs: { id: found.mention.id, label: found.mention.label } });
      cursor = found.index + found.token.length;
    }
    return nodes;
  };
  const rich = comment.rich_content?.version === 1 ? structuredClone(comment.rich_content.doc) : null;
  const mentions = !rich ? (comment.mentions || []).filter((mention) => mention?.id && mention?.label) : [];
  const doc = rich || {
    type: "doc",
    content: (comment.content || "").split(/\r?\n/).map((line) => ({
      type: "paragraph", content: textNodes(line, mentions),
    })),
  };
  const attachmentIds = (comment.images || []).flatMap((item) =>
    item?.attachment?.id ? [String(item.attachment.id)] : []);
  const represented = new Set(collectImages(doc));
  const missing = attachmentIds.filter((id) => !represented.has(id));
  if (missing.length) {
    if (!doc.content?.length) doc.content = [{ type: "paragraph", content: [] }];
    let paragraph = [...doc.content].reverse().find((node) => node.type === "paragraph");
    if (!paragraph) { paragraph = { type: "paragraph", content: [] }; doc.content.push(paragraph); }
    paragraph.content = [...(paragraph.content || []), ...missing.map((attachmentId) => ({
      type: "commentImage", attrs: { attachmentId },
    }))];
  }
  return doc;
}

export function groupDiscussion(comments = []) {
  const byId = new Map(comments.map((comment) => [String(comment.id), { ...comment, replies: [] }]));
  const roots = [];
  for (const comment of comments) {
    const node = byId.get(String(comment.id));
    const parent = comment.parent_comment_id == null ? null : byId.get(String(comment.parent_comment_id));
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }
  return roots;
}
