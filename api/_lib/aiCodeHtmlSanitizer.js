// AI Design Studio V2 — server-side HTML + inline-SVG sanitiser (Task #2904).
//
// Real parser-based sanitisation (jsdom + DOMPurify), NOT regex. Runs before
// any generated markup is persisted or rendered. Guarantees (spec §16):
//   - no <script>, event handlers, iframes, objects, embeds, forms, meta,
//     link, base or style tags
//   - no dangerous URLs (javascript:, data: except safe image data URIs are
//     ALSO blocked — assets must come from the media library)
//   - inline SVG allowed but stripped of scripts/foreignObject/external refs
//   - unknown custom elements removed
//   - iConnect control attributes preserved: data-ai-id, data-ai-action,
//     data-iconnect-slot, data-slot-key, data-content-key
//
// Returns both the clean HTML and a report of what was referenced/removed so
// the pipeline can cross-check manifests and the inspector can display
// sanitiser changes.

import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// Tags the composition may use. DOMPurify's html+svg+svgFilters profiles are
// further restricted by FORBID_TAGS below; this ALLOWED list is the positive
// gate so unknown/custom elements are dropped entirely.
const ALLOWED_HTML_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br',
  'caption', 'cite', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'li', 'main', 'mark', 'nav', 'ol', 'p',
  'picture', 'pre', 'q', 'section', 'small', 'source', 'span', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'time', 'tr', 'u', 'ul', 'wbr',
  '#text', // text nodes — required when ALLOWED_TAGS replaces the default set
];

const ALLOWED_SVG_TAGS = [
  'svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix',
  'feComposite', 'feFlood', 'feMerge', 'feMergeNode', 'feDropShadow',
];

const ALLOWED_ATTRS = [
  // Global / HTML
  'class', 'id', 'title', 'lang', 'dir', 'role', 'tabindex',
  'href', 'target', 'rel', 'src', 'srcset', 'sizes', 'alt', 'width', 'height',
  'loading', 'decoding', 'open', 'colspan', 'rowspan', 'scope', 'datetime',
  'media', 'type',
  // ARIA
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden',
  'aria-expanded', 'aria-current', 'aria-live',
  // SVG presentation & geometry
  'viewBox', 'xmlns', 'preserveAspectRatio', 'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit', 'opacity',
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'transform', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform',
  'clip-path', 'clip-rule', 'mask', 'filter', 'stdDeviation', 'dx', 'dy',
  'flood-color', 'flood-opacity', 'result', 'in', 'in2', 'mode', 'operator',
  'values', 'font-size', 'font-family', 'font-weight', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'vector-effect',
];

// Explicitly forbidden even though profiles might allow them.
const FORBID_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'form', 'input', 'textarea', 'select', 'option', 'button', 'label',
  'meta', 'link', 'base', 'noscript', 'template', 'slot', 'dialog',
  'audio', 'video', 'track', 'canvas', 'foreignObject', 'animate',
  'animateMotion', 'animateTransform', 'set', 'image',
];

const SAFE_HREF_RE = /^(#|\/(?!\/)|https:\/\/|mailto:|tel:)/i;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

let purifierSingleton = null;
function getPurifier() {
  if (purifierSingleton) return purifierSingleton;
  const window = new JSDOM('').window;
  purifierSingleton = createDOMPurify(window);
  return purifierSingleton;
}

/**
 * Sanitise a V2 composition HTML string.
 *
 * options.allowedImageHosts — array of URL prefixes an <img src> / srcset may
 * use (the tenant media-library public prefix). Anything else is stripped and
 * reported (the element keeps its place with src removed → broken-media gate
 * catches it later, rather than silently fetching third-party content).
 *
 * Returns { html, report } where report = {
 *   aiIds: [..], actionKeys: [..], slotKeys: [..], contentKeys: [..],
 *   removed: [{ kind, detail }], headings: ['h2', ...]
 * }
 */
export function sanitizeAiCodeHtml(rawHtml, { allowedImageHosts = [] } = {}) {
  const DOMPurify = getPurifier();
  const removed = [];

  const hookRemoved = (payload, kind) => {
    const tag = payload?.element?.tagName || payload?.attribute?.name || '';
    if (tag) removed.push({ kind, detail: String(tag).toLowerCase() });
  };
  DOMPurify.removeAllHooks();
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    const t = data.tagName;
    if (data.allowedTags && !data.allowedTags[t]
        && !t.startsWith('#') && !['body', 'html', 'head'].includes(t)) {
      removed.push({ kind: 'element', detail: t });
    }
  });
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.allowedAttributes && !data.allowedAttributes[data.attrName]
        && !/^data-/.test(data.attrName) && !/^aria-/.test(data.attrName)) {
      removed.push({ kind: 'attribute', detail: data.attrName });
    }
  });

  const clean = DOMPurify.sanitize(String(rawHtml || ''), {
    ALLOWED_TAGS: [...ALLOWED_HTML_TAGS, ...ALLOWED_SVG_TAGS],
    ALLOWED_ATTR: ALLOWED_ATTRS,
    FORBID_TAGS,
    ALLOW_DATA_ATTR: true,          // data-ai-id / data-ai-action / slots / content keys
    ALLOW_ARIA_ATTR: true,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: false,            // forbidden containers drop entirely (no orphan text from <script> etc.)
    USE_PROFILES: undefined,
  });
  DOMPurify.removeAllHooks();
  void hookRemoved;

  // Second parser pass for policy that DOMPurify config can't express.
  const dom = new JSDOM(`<body>${clean}</body>`);
  const doc = dom.window.document;

  const aiIds = [];
  const actionKeys = [];
  const slotKeys = [];
  const contentKeys = [];
  const headings = [];

  const isAllowedImageUrl = (url) => {
    const u = String(url || '').trim();
    if (!u) return false;
    if (u.startsWith('/') && !u.startsWith('//')) return true; // same-origin relative
    return allowedImageHosts.some((p) => p && u.startsWith(p));
  };

  const all = Array.from(doc.body.querySelectorAll('*'));
  for (const el of all) {
    const tag = el.tagName.toLowerCase();

    // Strip any data-* attribute outside the approved control set.
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('data-')
          && !['data-ai-id', 'data-ai-action', 'data-iconnect-slot', 'data-slot-key', 'data-content-key'].includes(n)) {
        el.removeAttribute(attr.name);
        removed.push({ kind: 'attribute', detail: n });
      }
      if (n.startsWith('on')) { // belt & braces — DOMPurify already removed these
        el.removeAttribute(attr.name);
        removed.push({ kind: 'attribute', detail: n });
      }
    }

    const aiId = el.getAttribute('data-ai-id');
    if (aiId) {
      if (KEY_RE.test(aiId)) aiIds.push(aiId);
      else { el.removeAttribute('data-ai-id'); removed.push({ kind: 'attribute', detail: `data-ai-id=${aiId}` }); }
    }
    const contentKey = el.getAttribute('data-content-key');
    if (contentKey) {
      if (KEY_RE.test(contentKey)) contentKeys.push(contentKey);
      else el.removeAttribute('data-content-key');
    }

    if (/^h[1-6]$/.test(tag)) headings.push(tag);

    // Links: action-keyed anchors get their href managed by iConnect (the
    // renderer resolves the action). Raw hrefs must be safe schemes.
    if (tag === 'a') {
      const action = el.getAttribute('data-ai-action');
      if (action) {
        if (KEY_RE.test(action)) {
          actionKeys.push(action);
          // href is a render-time concern; neutralise whatever the model put in.
          el.setAttribute('href', '#');
        } else {
          el.removeAttribute('data-ai-action');
          removed.push({ kind: 'attribute', detail: `data-ai-action=${action}` });
        }
      }
      const href = el.getAttribute('href');
      if (href && !SAFE_HREF_RE.test(href)) {
        el.removeAttribute('href');
        removed.push({ kind: 'url', detail: `a[href]=${href.slice(0, 100)}` });
      }
      // External links never inherit the app's opener.
      if (el.getAttribute('target') === '_blank') el.setAttribute('rel', 'noopener noreferrer');
      else el.removeAttribute('target');
    }

    // Slot placeholders: must be empty containers — trusted components render
    // inside them; generated children are discarded.
    const slotKey = el.getAttribute('data-iconnect-slot');
    if (slotKey !== null) {
      const key = el.getAttribute('data-slot-key') || slotKey;
      if (KEY_RE.test(key)) {
        slotKeys.push(key);
        el.setAttribute('data-slot-key', key);
        el.innerHTML = '';
      } else {
        el.removeAttribute('data-iconnect-slot');
        el.removeAttribute('data-slot-key');
        removed.push({ kind: 'attribute', detail: `data-iconnect-slot=${slotKey}` });
      }
    }

    // Images: only media-library / same-origin sources survive.
    if (tag === 'img' || tag === 'source') {
      for (const attr of ['src', 'srcset']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const urls = attr === 'srcset' ? v.split(',').map((s) => s.trim().split(/\s+/)[0]) : [v];
        if (!urls.every(isAllowedImageUrl)) {
          el.removeAttribute(attr);
          removed.push({ kind: 'url', detail: `${tag}[${attr}]=${String(v).slice(0, 100)}` });
        }
      }
      if (tag === 'img' && !el.hasAttribute('alt')) el.setAttribute('alt', '');
    }

    // SVG: internal references only. <use href> must be a local fragment.
    if (tag === 'use') {
      const ref = el.getAttribute('href') || el.getAttribute('xlink:href');
      if (!ref || !ref.startsWith('#')) {
        el.remove();
        removed.push({ kind: 'url', detail: `use[href]=${String(ref).slice(0, 100)}` });
        continue;
      }
    }
    // url(...) style values inside SVG presentation attrs must be fragments.
    for (const attr of ['fill', 'stroke', 'clip-path', 'mask', 'filter']) {
      const v = el.getAttribute(attr);
      if (v && /url\s*\(/i.test(v) && !/^url\(['"]?#/i.test(v.trim())) {
        el.removeAttribute(attr);
        removed.push({ kind: 'url', detail: `${tag}[${attr}]=${String(v).slice(0, 100)}` });
      }
    }
    // No inline style attributes anywhere — all presentation flows through the
    // scoped stylesheet (keeps the CSS gate the single choke point).
    if (el.hasAttribute('style')) {
      el.removeAttribute('style');
      removed.push({ kind: 'attribute', detail: 'style' });
    }
  }

  return {
    html: doc.body.innerHTML,
    report: { aiIds, actionKeys, slotKeys, contentKeys, headings, removed },
  };
}
