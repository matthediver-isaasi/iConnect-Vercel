// A versioned JSON document, never HTML. Legacy strings are always literal text.
export const discussionUuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const DISCUSSION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '😊'];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function safeDiscussionLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) &&
      (url.protocol === 'mailto:' ? Boolean(url.pathname) : Boolean(url.hostname) && !url.username && !url.password);
  } catch { return false; }
}

export function normalizeDiscussionContent({ content, richContent, attachmentIds = [], mentionIdentityIds = [] }) {
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some(id => !discussionUuid(id))) fail('Invalid comment images');
  if (!Array.isArray(mentionIdentityIds) || mentionIdentityIds.length > 50 || mentionIdentityIds.some(id => !discussionUuid(id))) fail('Invalid mention recipients');
  const images = [...new Set(attachmentIds)];
  if (richContent == null) {
    if (typeof content !== 'string' || content.length > 20000 ||
      (!content.replace(/[\s\u200b-\u200d\ufeff]/gu, '') && !images.length)) fail('Comment content is required');
    return { content: content.trim(), richContent: null, attachmentIds: images, mentionIdentityIds: [...new Set(mentionIdentityIds)] };
  }
  if (JSON.stringify(richContent).length > 100000 || richContent.version !== 1 || richContent.doc?.type !== 'doc') fail('Invalid rich comment document');
  const recipients = new Set();
  const imageNodes = new Set();
  let nodes = 0;
  const block = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote']);
  const inline = new Set(['text', 'hardBreak', 'mention', 'commentImage']);
  const walk = (node, parent, depth = 0) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || ++nodes > 3000 || depth > 20) fail('Comment document is too complex');
    const { type } = node;
    const allowed = parent === null ? type === 'doc'
      : ['paragraph', 'heading'].includes(parent) ? inline.has(type)
      : ['bulletList', 'orderedList'].includes(parent) ? type === 'listItem'
      : block.has(type) || (type === 'commentImage' && ['doc', 'blockquote', 'listItem'].includes(parent));
    if (!allowed) fail('Unsupported comment content');
    const clean = { type };
    if (type === 'text') {
      if (typeof node.text !== 'string' || !node.text.length) fail('Invalid comment text');
      clean.text = node.text;
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks) || node.marks.length > 5) fail('Invalid formatting');
        clean.marks = node.marks.map(mark => {
          if (!['bold', 'italic', 'underline', 'strike', 'link'].includes(mark?.type)) fail('Unsupported formatting');
          if (mark.type !== 'link') return { type: mark.type };
          if (!safeDiscussionLink(mark.attrs?.href)) fail('Use a safe http, https or mailto link');
          return { type: 'link', attrs: { href: mark.attrs.href } };
        });
      }
    } else if (type === 'mention') {
      const { id, label } = node.attrs || {};
      if (!discussionUuid(id) || typeof label !== 'string' || !label.trim() || label.length > 300 || /[\r\n]/.test(label)) fail('Invalid mention');
      recipients.add(id);
      if (recipients.size > 50) fail('Too many mentions');
      clean.attrs = { id, label };
    } else if (type === 'commentImage') {
      if (!images.includes(node.attrs?.attachmentId)) fail('Image must reference an attached image on this task');
      imageNodes.add(node.attrs.attachmentId);
      clean.attrs = { attachmentId: node.attrs.attachmentId };
    } else if (type === 'heading') {
      if (![1, 2, 3].includes(node.attrs?.level)) fail('Unsupported heading');
      clean.attrs = { level: node.attrs.level };
    } else if (type === 'orderedList') {
      const start = node.attrs?.start ?? 1;
      if (!Number.isInteger(start) || start < 1 || start > 10000) fail('Invalid list start');
      clean.attrs = { start };
    }
    if (!inline.has(type)) {
      if (node.content !== undefined && !Array.isArray(node.content)) fail('Invalid document children');
      clean.content = (node.content || []).map(child => walk(child, type, depth + 1));
    } else if (node.content?.length) fail('Invalid inline content');
    return clean;
  };
  const doc = walk(richContent.doc, null);
  if (images.some(id => !imageNodes.has(id))) fail('Every comment image must be retained in the document');
  const text = node => node.type === 'text' ? node.text
    : node.type === 'mention' ? `@${node.attrs.label}`
    : node.type === 'hardBreak' ? '\n'
    : node.type === 'commentImage' ? ''
    : (node.content || []).map(text).join(['paragraph', 'heading'].includes(node.type) ? '' : '\n');
  const projection = text(doc).trim();
  if (projection.length > 20000 || (!projection.replace(/[\s\u200b-\u200d\ufeff]/gu, '') && !images.length)) fail('Comment content is required');
  return { content: projection, richContent: { version: 1, doc }, attachmentIds: images, mentionIdentityIds: [...recipients] };
}
