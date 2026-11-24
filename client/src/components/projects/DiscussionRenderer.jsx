import { safeDiscussionUrl } from "./discussionFormat.mjs";
import "./discussion.css";

function renderInline(node, key, attachments) {
  if (node.type === "text") {
    let content = node.text || "";
    for (const mark of node.marks || []) {
      if (mark.type === "link") {
        const href = safeDiscussionUrl(mark.attrs?.href);
        if (href) content = <a key={`${key}-link`} href={href} target="_blank" rel="noopener noreferrer">{content}</a>;
      } else {
        const Tag = ({ bold: "strong", italic: "em", underline: "u", strike: "s" })[mark.type];
        if (Tag) content = <Tag key={`${key}-${mark.type}`}>{content}</Tag>;
      }
    }
    return <span key={key}>{content}</span>;
  }
  if (node.type === "mention") return <span key={key} className="discussion-mention" data-identity-id={node.attrs?.id}>@{node.attrs?.label || "Board member"}</span>;
  if (node.type === "hardBreak") return <br key={key} />;
  if (node.type === "commentImage") {
    const attachment = attachments.find((item) => String(item?.attachment?.id || item?.id) === String(node.attrs?.attachmentId));
    const image = attachment?.attachment || attachment;
    return image?.url && /^(https?:\/\/|\/(?!\/))/i.test(image.url)
      ? <img key={key} src={image.url} alt={node.attrs?.alt || image.name || "Comment image"} loading="lazy" className="my-2 max-h-64 max-w-full rounded-md border object-contain" />
      : <span key={key} className="text-xs text-muted-foreground">Image attachment removed.</span>;
  }
  return null;
}
function renderNode(node, key, attachments) {
  const children = (node.content || []).map((child, index) => renderNode(child, `${key}-${index}`, attachments));
  if (node.type === "doc") return <>{children}</>;
  if (node.type === "text" || node.type === "mention" || node.type === "hardBreak" || node.type === "commentImage") return renderInline(node, key, attachments);
  const Tag = node.type === "heading" ? `h${Math.max(1, Math.min(3, Number(node.attrs?.level) || 2))}`
    : ({ paragraph: "p", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote" })[node.type];
  return Tag ? <Tag key={key}
    {...(node.type === "orderedList" && Number(node.attrs?.start) > 1 ? { start: Number(node.attrs.start) } : {})}
    className={node.type === "blockquote" ? "border-l-2 border-primary/40 pl-3 italic" : undefined}>{children}</Tag> : <>{children}</>;
}

export default function DiscussionRenderer({ richContent, content = "", attachments = [] }) {
  if (richContent?.version === 1 && richContent.doc) return <div className="discussion-renderer">{renderNode(richContent.doc, "doc", attachments)}</div>;
  // Historical content is text, never HTML. React escaping preserves literal markup.
  return content ? <p className="whitespace-pre-wrap break-words">{content}</p> : null;
}
