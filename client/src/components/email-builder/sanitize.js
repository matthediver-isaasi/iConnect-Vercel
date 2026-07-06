import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a', 'hr', 'span',
  'blockquote', 'pre', 'code',
];

const ALLOWED_ATTR = [
  'href', 'target', 'rel', 'style', 'class',
  // Task #974: responsive per-device font-size on Tiptap textStyle spans.
  // The desktop value lives in inline `style="font-size:…"`; the tablet
  // and mobile values are stored as data attributes so the Canvas
  // renderer can extract them and emit per-block @media CSS. They are
  // explicitly allow-listed here (rather than turning on
  // ALLOW_DATA_ATTR globally) so we don't accidentally let other
  // unknown data-* attributes through.
  'data-fs-tablet', 'data-fs-mobile',
];

export function sanitizeHtml(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

export function stripTrailingEmptyParagraphs(html) {
  if (!html) return '';
  return html.replace(/(<p[^>]*>\s*(<br[^>]*\/?>)?\s*(&nbsp;|\u00A0)?\s*<\/p>\s*)+$/i, '');
}

// True when a rich-text HTML string carries no meaningful content — i.e. it is
// blank, or only empty markup such as `<p></p>`, `<p><br></p>`, or
// whitespace / non-breaking spaces. Elements that are meaningful even without
// text (images, rules, tables, media) are always treated as non-empty. Use
// this instead of a bare `String(x).trim()` check, which would wrongly treat
// `<p></p>` as non-empty.
export function isRichTextEmpty(html) {
  if (html == null) return true;
  const s = String(html);
  if (/<(img|hr|iframe|video|audio|table|figure)[\s/>]/i.test(s)) return false;
  const stripped = s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|\u00A0/gi, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}
