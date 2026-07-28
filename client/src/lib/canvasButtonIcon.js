// Shared, React-free helpers for canvas icon handling (Task #3167).
//
// Extracted from blocks/registry.jsx so the icon-name resolution and the
// icon-only Button style recipe can be unit-tested under node without pulling
// the whole block registry (and its React/browser deps) into the test.
// registry.jsx re-exports `isFaIconName` for its existing consumers.

// Detect whether a stored icon name is a Font Awesome class string picked via
// the FA icon picker (e.g. "fa-solid fa-star"). A real FA class string always
// has MULTIPLE tokens: a style token (fa/fas/far/fab/fa-solid/...) plus an
// fa-<icon> token — so single-token Lucide names like "factory", "fan" or
// "fast-forward" are never treated as FA.
export const FA_STYLE_TOKEN = /^(fa|fas|far|fab|fal|fad|fat|fass|fasr|fasl|fa-solid|fa-regular|fa-brands|fa-light|fa-duotone|fa-thin|fa-sharp)$/;

export function isFaIconName(name) {
  if (typeof name !== 'string') return false;
  const tokens = name.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  return tokens.some((t) => FA_STYLE_TOKEN.test(t)) &&
    tokens.some((t) => /^fa-[a-z0-9-]+$/.test(t) && !FA_STYLE_TOKEN.test(t));
}

// Sanitize an author-supplied Font Awesome class string. Only tokens that
// start with `fa` and consist of [a-z0-9-] survive (e.g. `fa-solid`,
// `fa-book-open`, legacy `fas`/`fab`). This blocks arbitrary class injection
// while allowing every Font Awesome style prefix + icon name.
export function sanitizeFaIconClass(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .split(/\s+/)
    .filter((t) => /^fa[a-z0-9-]*$/.test(t))
    .join(' ');
}

// Resolve a raw stored icon value (Font Awesome class string OR Lucide icon
// name) to a name `renderStyleIcon` can handle, or '' when it is neither.
// Legacy bare fa- tokens (stored without a style token) get "fa-solid" added
// so they keep rendering as FA rather than being mistaken for Lucide names.
// (Previously lived in registry.jsx as the Image block's `_resolveImageIconName`.)
export function resolveStoredIconName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const n = raw.trim();
  if (!n) return '';
  if (isFaIconName(n)) return sanitizeFaIconClass(n) ? n : '';
  if (/^fa-[a-z0-9-]+$/i.test(n) && !FA_STYLE_TOKEN.test(n)) return `fa-solid ${n}`;
  if (/^[A-Za-z][A-Za-z0-9-]*$/.test(n)) return n; // Lucide (kebab or Pascal)
  return '';
}

// --- Icon-only Button mode (Task #3167) -------------------------------------

// Read the icon-only settings off a Button block's content. Strict-true
// gating: legacy buttons without the keys stay in labeled mode.
export function readIconOnly(content) {
  const c = content || {};
  const iconOnly = c.iconOnly === true;
  return {
    iconOnly,
    circle: iconOnly && c.iconShape === 'circle',
  };
}

// Style overrides layered onto a Button anchor's inline style when icon-only
// mode is on. `padY` is the resolved vertical padding value (px string or CSS
// var()) — icon-only buttons use it on ALL four sides so the button is
// symmetric, and stop growing to label width (the anchor just fills the
// block's stored box). Circle shape wins over the variant's radius.
export function buildIconOnlyAnchorStyle(padY, circle) {
  const out = {
    paddingTop: padY,
    paddingBottom: padY,
    paddingLeft: padY,
    paddingRight: padY,
    minWidth: '100%',
    width: '100%',
  };
  if (circle) out.borderRadius = '9999px';
  return out;
}

// Accessible name for an icon-only button: explicit screen-reader label
// first, then the (hidden) label text, then a generic fallback so the anchor
// is never nameless. Labeled buttons keep their legacy behaviour (aria-label
// only when explicitly set).
export function resolveIconOnlyAriaLabel(content) {
  const c = content || {};
  return (c.ariaLabel || '').trim() || (c.label || '').trim() || 'Button';
}
