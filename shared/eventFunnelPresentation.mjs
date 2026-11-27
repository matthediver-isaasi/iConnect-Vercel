// Display content only: never interpreted as prices, eligibility or routing.
export const FUNNEL_PRESENTATION_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li', 'a', 'blockquote', 'hr', 'span',
];
export const FUNNEL_PRESENTATION_ATTRS = ['href', 'title', 'target', 'rel'];

export function isFunnelImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  if (value === '') return true;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function funnelPresentationIssue(node) {
  if (node.presentation === undefined) return null;
  const value = node.presentation;
  if (node.type !== 'addon' || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['heading', 'bodyHtml', 'imageUrl'].includes(key))) {
    return 'Modal content is available only for event add-on steps.';
  }
  if (value.heading !== undefined && (typeof value.heading !== 'string' || value.heading.length > 200)) {
    return 'Modal headings must be 200 characters or fewer.';
  }
  if (value.bodyHtml !== undefined && (typeof value.bodyHtml !== 'string' || value.bodyHtml.length > 20000)) {
    return 'Modal content must be 20,000 characters or fewer.';
  }
  if (value.imageUrl !== undefined && !isFunnelImageUrl(value.imageUrl)) {
    return 'Choose a valid HTTP, HTTPS or site-relative modal image URL.';
  }
  return null;
}
