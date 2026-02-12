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
