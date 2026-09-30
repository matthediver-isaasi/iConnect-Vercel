// Responsive tenant-typography CSS helpers for canvas blocks.
//
// React-free on purpose: these are imported by the block registry
// (client/src/components/canvas/blocks/registry.jsx) and covered directly
// by node --test (canvasTypographyResponsive.test.mjs).
//
// Task #2839 contract: the @media override rules MUST target the element
// that carries the inline desktop typography style, never just the block
// wrapper. An `!important` declaration on the wrapper only wins on the
// wrapper itself — the inner element's inline `font-size` beats anything it
// would otherwise inherit, and `margin-bottom` does not inherit at all. The
// Text block therefore tags its rendered element with
// `data-tg-r="text-root"` and the selector built here targets it.

import { BREAKPOINT_MAX_PX } from './canvasDesign.js';

// Task #974: cascade mobile -> tablet -> desktop for the four
// per-device tenant typography properties (font-size, line-height,
// letter-spacing, margin-bottom). When the caller doesn't specify a
// breakpoint we fall back to the desktop value so callers that
// pre-date the responsive contract behave byte-identically.
export function pickResponsiveTypoValue(style, baseKey, breakpoint) {
  if (!style) return null;
  const desk = style[baseKey];
  if (breakpoint === 'mobile') {
    return style[`${baseKey}_mobile`] ?? style[`${baseKey}_tablet`] ?? desk;
  }
  if (breakpoint === 'tablet') {
    return style[`${baseKey}_tablet`] ?? desk;
  }
  return desk;
}

// True when the tenant style declares any tablet- or mobile-specific
// override that differs from the desktop value (for the four per-device
// properties font-size / line-height / letter-spacing / margin-bottom).
export function hasResponsiveTypographyOverride(tenantStyle) {
  if (!tenantStyle) return false;
  for (const k of ['font_size', 'line_height', 'letter_spacing', 'margin_bottom']) {
    const d = tenantStyle[k];
    const t = tenantStyle[`${k}_tablet`];
    const m = tenantStyle[`${k}_mobile`];
    if (t != null && t !== d) return true;
    if (m != null && m !== d) return true;
  }
  return false;
}

// Build the @media (max-width: …) blocks that override the chosen
// typography properties at the tablet and mobile breakpoints. The
// `selector` argument is the CSS selector the rules should target — it MUST
// resolve to the element that carries the inline desktop typography style
// (e.g. `[data-cb="<id>"] [data-tg-r="headline"]`), NOT the bare block
// wrapper: an inline style on a child always beats values inherited from
// the wrapper, even with !important on the wrapper rule. Uses !important so
// the declarations beat the inline-style desktop value on that same
// element. Mobile rules are only emitted when the mobile value differs from
// whatever applies at tablet (desktop or tablet override) to keep the
// stylesheet small. Returns null when no override applies.
export function buildTenantTypographyResponsiveCss(selector, style) {
  if (!style || !selector) return null;
  const PROPS = [
    { css: 'font-size', key: 'font_size', unit: 'px' },
    { css: 'line-height', key: 'line_height', unit: '' },
    { css: 'letter-spacing', key: 'letter_spacing', unit: 'px' },
    { css: 'margin-bottom', key: 'margin_bottom', unit: 'px' },
  ];
  const tabletDecls = [];
  const mobileDecls = [];
  for (const p of PROPS) {
    const d = style[p.key];
    const t = style[`${p.key}_tablet`];
    const m = style[`${p.key}_mobile`];
    const tabletWins = t != null && t !== d;
    if (tabletWins) {
      tabletDecls.push(`${p.css}:${t}${p.unit} !important;`);
    }
    const effective = tabletWins ? t : d;
    if (m != null && m !== effective) {
      mobileDecls.push(`${p.css}:${m}${p.unit} !important;`);
    }
  }
  const parts = [];
  if (tabletDecls.length) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.tablet}px){${selector}{${tabletDecls.join('')}}}`);
  }
  if (mobileDecls.length) {
    parts.push(`@media (max-width:${BREAKPOINT_MAX_PX.mobile}px){${selector}{${mobileDecls.join('')}}}`);
  }
  return parts.length ? parts.join('') : null;
}

// Marker attribute the Text block renderer places on the element that
// carries the inline typography style (the rendered h1–h6/p/div itself).
export const TEXT_ROOT_ATTR = 'data-tg-r';
export const TEXT_ROOT_VALUE = 'text-root';

// Selector for the Text block's typography target: the tagged element
// inside the block wrapper. Targeting the element (not the wrapper) is what
// lets the !important @media declarations beat its inline desktop values.
export function textTypographySelector(blockId) {
  const safeId = String(blockId).replace(/["\\]/g, '');
  return `[data-cb="${safeId}"] [${TEXT_ROOT_ATTR}="${TEXT_ROOT_VALUE}"]`;
}

export function buildTextResponsiveTypographyCss(blockId, tenantStyle) {
  if (!tenantStyle || !blockId) return null;
  return buildTenantTypographyResponsiveCss(textTypographySelector(blockId), tenantStyle);
}
