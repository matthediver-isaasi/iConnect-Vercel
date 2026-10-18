import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

let purifier;
export function sanitizeAgreementHtml(html) {
  if (!html) return '';
  purifier ||= createDOMPurify(new JSDOM('').window);
  const clean = purifier.sanitize(String(html), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h1', 'h2', 'h3', 'h4',
      'ul', 'ol', 'li', 'blockquote', 'hr', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['colspan', 'rowspan', 'start'],
    ALLOW_DATA_ATTR: false,
  });
  // An empty rich-text editor must not opt an ordinary quote into signing.
  return clean.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() ? clean : '';
}
