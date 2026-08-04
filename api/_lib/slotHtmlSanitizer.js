// Rich-text dynamic slot sanitizer (Task #3377).
//
// Group Email dynamic text slots may now carry rich HTML authored in the
// TipTap slot editor. Before that HTML is injected into an outgoing email
// body (send, test-send, or the inbox/sent view) it MUST pass through
// sanitizeSlotHtml so a slot value can never smuggle scripts, event handlers,
// iframes or other dangerous markup into delivered emails.
//
// The allowlist intentionally mirrors the client-side editor sanitizer
// (client/src/components/email-builder/sanitize.js) so what the admin sees in
// the composer preview matches what the server will actually inject.

import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'a', 'hr', 'span',
  'blockquote', 'pre', 'code',
];

const ALLOWED_ATTR = ['href', 'target', 'rel', 'style', 'class'];

let purify = null;
function getPurify() {
  if (!purify) {
    const { window } = new JSDOM('');
    purify = createDOMPurify(window);
  }
  return purify;
}

/**
 * Sanitize a rich-text slot value for safe injection into an HTML email body.
 * Strips scripts, event handlers, javascript: URLs, and any tag/attribute
 * outside the small formatting allowlist. Returns '' for empty input.
 */
export function sanitizeSlotHtml(html) {
  if (html == null || html === '') return '';
  return getPurify().sanitize(String(html), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Convert a rich-text slot value to plain text for contexts where no markup
 * may be injected (email subjects). Tags are dropped, block/line-break tags
 * become single spaces, and common entities are decoded.
 */
export function htmlSlotToPlainText(html) {
  if (html == null || html === '') return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/(p|li|h[1-6]|div|blockquote|pre)>/gi, ' ');
  s = s.replace(/<[^>]*>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/gi, '&');
  return s.replace(/\s+/g, ' ').trim();
}
