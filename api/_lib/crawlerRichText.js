import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

let purifier;
let document;
const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Crawler content is deliberately unstyled, but must retain its meaning and
// structure. Sanitize with a parser, not stripHtml or a substring limit.
export function crawlerRichText(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (!purifier) {
    const window = new JSDOM('').window;
    document = window.document;
    purifier = createDOMPurify(window);
  }
  const decoder = document.createElement('textarea');
  decoder.innerHTML = value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = /<\/?[a-z][^>]*>/i.test(value)
    ? value
    : decoder.value.split(/\r?\n\s*\r?\n/).map(p => `<p>${escapeText(p).replace(/\r?\n/g, '<br>')}</p>`).join('');
  const fragment = purifier.sanitize(html, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'q', 'cite',
      'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup',
      'a', 'abbr', 'code', 'pre', 'div', 'span', 'section', 'article',
      'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
      'figure', 'figcaption', 'img', 'time'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'id', 'lang', 'dir',
      'colspan', 'rowspan', 'scope', 'start', 'reversed', 'value', 'datetime'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const element of fragment.querySelectorAll('[href], [src]')) {
    for (const attr of ['href', 'src']) {
      if (!element.hasAttribute(attr)) continue;
      try {
        const protocol = new URL(element.getAttribute(attr), 'https://crawler.invalid').protocol;
        const allowed = attr === 'href' ? ['https:', 'http:', 'mailto:', 'tel:'] : ['https:', 'http:'];
        if (!allowed.includes(protocol)) element.removeAttribute(attr);
      } catch { element.removeAttribute(attr); }
    }
  }
  const container = fragment.ownerDocument.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
