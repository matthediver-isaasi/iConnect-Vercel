import DOMPurify from 'dompurify';
import { sanitizeHtml as sanitizeRichText, stripTrailingEmptyParagraphs } from '@/components/email-builder/sanitize';

// Re-export the rich-text sanitiser from the email builder so canvas
// rich-text blocks use the same allowlist & behaviour.
export { sanitizeRichText, stripTrailingEmptyParagraphs };

// Custom-HTML block sanitiser. A broader allowlist than the rich-text one
// (lets editors paste in things like tables, figures, captions, divs), but
// still strips scripts, event handlers, and other XSS vectors via DOMPurify.
const CUSTOM_HTML_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a', 'hr', 'span', 'div',
  'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'img',
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'main',
  'small', 'sub', 'sup', 'mark', 'time', 'cite', 'kbd', 'dfn', 'abbr',
];

const CUSTOM_HTML_ATTRS = [
  'href', 'target', 'rel', 'style', 'class', 'id', 'role', 'aria-label',
  'aria-hidden', 'aria-describedby', 'aria-labelledby',
  'src', 'alt', 'title', 'width', 'height', 'loading', 'colspan', 'rowspan',
  'data-*',
];

export function sanitizeCustomHtml(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: CUSTOM_HTML_TAGS,
    ALLOWED_ATTR: CUSTOM_HTML_ATTRS,
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit'],
  });
}
