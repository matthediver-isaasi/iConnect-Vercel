import { parseFragment } from 'parse5';

// Canvas TipTap text only. Never apply this contract to email templates,
// attributes, URLs, Custom HTML, or persisted page/symbol designs.
export const CANVAS_MEMBER_TOKENS = Object.freeze([
  { label: 'First name', key: 'member.first_name', token: '{{member.first_name}}' },
  { label: 'Last name', key: 'member.last_name', token: '{{member.last_name}}' },
  { label: 'Job title', key: 'member.job_title', token: '{{member.job_title}}' },
  { label: 'Linked organisation name', key: 'member.organization.name', token: '{{member.organization.name}}' },
].map(Object.freeze));

const TOKEN_PATTERN = /\{\{(member\.(?:first_name|last_name|job_title|organization\.name))\}\}/g;
const NON_TEXT_CONTAINERS = new Set([
  'script', 'style', 'iframe', 'textarea', 'title', 'noscript', 'xmp', 'plaintext', 'template',
]);

function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Resolve an allowlisted flat key -> string map in HTML text nodes only.
 * The caller is responsible for validating the viewer and sanitizing HTML.
 * Source-location edits preserve unrelated markup/attributes byte-for-byte.
 * Replacement is single-pass: member data that resembles a token stays data.
 */
export function resolveCanvasMemberHtml(html, values = {}) {
  if (typeof html !== 'string') return '';
  if (!html.includes('{{member.')) return html;
  const tree = parseFragment(html, { sourceCodeLocationInfo: true });
  const edits = [];
  const visit = (node) => {
    if (NON_TEXT_CONTAINERS.has(node.tagName)) return;
    if (node.nodeName === '#text' && node.sourceCodeLocation) {
      let changed = false;
      const text = node.value.replace(TOKEN_PATTERN, (_, key) => {
        changed = true;
        return values && Object.hasOwn(values, key) && typeof values[key] === 'string'
          ? values[key]
          : '';
      });
      if (changed) {
        edits.push({ ...node.sourceCodeLocation, text: escapeText(text) });
      }
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(tree);
  let result = html;
  for (const edit of edits.sort((a, b) => b.startOffset - a.startOffset)) {
    result = result.slice(0, edit.startOffset) + edit.text + result.slice(edit.endOffset);
  }
  return result;
}

// For already-plain text derived from a TipTap field, not arbitrary content.
export function removeCanvasMemberTokens(text) {
  return typeof text === 'string' ? text.replace(TOKEN_PATTERN, '') : '';
}

function neutralFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let next = value;
  for (const key of keys) {
    if (typeof value[key] !== 'string') continue;
    const neutral = resolveCanvasMemberHtml(value[key]);
    if (neutral === value[key]) continue;
    if (next === value) next = { ...value };
    next[key] = neutral;
  }
  return next;
}

/**
 * Neutral public/search/index projection of exactly the Canvas TipTap fields.
 * Walk nested flow nodes, advanced-accordion items and inline symbol designs.
 * Other fields, including plain headings, links and Custom HTML, are untouched.
 */
export function projectCanvasMemberTokensForGuest(value) {
  if (!value || typeof value !== 'object') return value;
  let source = value;
  if (value.content && typeof value.content === 'object') {
    const content = value.content;
    let nextContent = content;
    if (value.type === 'text') nextContent = neutralFields(content, ['html']);
    if (value.type === 'card') nextContent = neutralFields(content, ['body']);
    const listFields = {
      columns: ['items', ['html']],
      accordion: ['items', ['a']],
      'card-flip-grid': ['cards', ['summary', 'backText', 'content']],
      'hero-carousel': ['slides', ['headerText', 'subheadingText', 'contentText']],
      'hero-carousel-mobile': ['slides', ['headerText', 'subheadingText', 'contentText']],
    }[value.type];
    if (listFields && Array.isArray(content[listFields[0]])) {
      const [listKey, fields] = listFields;
      const list = content[listKey];
      const nextList = list.map((item) => {
        // The flip renderer intentionally treats legacy tag-free summaries
        // as plain text. Only its HTML branch is a TipTap token surface.
        const renderedFields = value.type === 'card-flip-grid'
          ? fields.filter((field) => field === 'content' || /<[a-z][\s\S]*>/i.test(item?.[field] || ''))
          : fields;
        return neutralFields(item, renderedFields);
      });
      if (nextList.some((item, i) => item !== list[i])) {
        nextContent = { ...content, [listKey]: nextList };
      }
    }
    if (nextContent !== content) source = { ...value, content: nextContent };
  }
  let next = source;
  for (const key of Object.keys(source)) {
    const child = source[key];
    if (!child || typeof child !== 'object') continue;
    const projected = projectCanvasMemberTokensForGuest(child);
    if (projected === child) continue;
    if (next === source) next = Array.isArray(source) ? [...source] : { ...source };
    next[key] = projected;
  }
  return next;
}