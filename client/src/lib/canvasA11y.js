// Canvas Builder accessibility audit engine (Phase 6).
//
// Pure functions that walk a normalized canvas design document and produce
// a flat list of issues, each keyed to a `blockId` so the editor can surface
// them inline (layers panel, inspector, audit panel).
//
// The audit emulates the subset of axe-core rules that matter to a free-form
// canvas builder: image alts, heading structure, contrast, accessible names
// on interactive elements, ARIA misuse, and mobile heuristics (overflow,
// touch-target size, hidden-on-mobile). We do not run axe-core in-process
// because it requires a real DOM; the editor can still drive an out-of-process
// axe scan against the public preview iframe in a later iteration.

import {
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
  getRootChildren,
  BLOCK_TYPES,
  BREAKPOINT_WIDTHS,
} from './canvasDesign.js';

export const SEVERITY = {
  ERROR: 'error',     // blocks publish
  WARNING: 'warning', // surfaces but does not block
  INFO: 'info',       // informational only
};

// Rules can be configured per-tenant in the future; for v1 these defaults
// match the "must fix to publish" list referenced in the task spec.
export const DEFAULT_BLOCKING_RULES = new Set([
  'image-alt-missing',
  'no-h1-on-page',
  'button-no-accessible-name',
  'link-image-no-accessible-name',
  'aria-hidden-focusable',
]);

// Block types that render genuinely keyboard-focusable content (a native
// <button>, an <a>, or a form field). Decorative/structural containers
// (boxes, sections, spacers, dividers, plain text/images) are never focusable
// on their own now that raw tabindex has been retired.
const INTERACTIVE_BLOCK_TYPES = new Set([
  BLOCK_TYPES.BUTTON,
  BLOCK_TYPES.PRICING_TABLE,
  BLOCK_TYPES.FORM_EMBED,
  BLOCK_TYPES.LOGIN_FORM,
  BLOCK_TYPES.SEARCH_INPUT,
]);

export function isInteractiveBlock(block) {
  if (!block) return false;
  if (INTERACTIVE_BLOCK_TYPES.has(block.type)) return true;
  // An image is only interactive when it is wrapped in a link.
  if (block.type === BLOCK_TYPES.IMAGE && block.content?.href) return true;
  return false;
}

// -- Colour & contrast helpers ----------------------------------------------

export function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent' || s === 'inherit' || s === 'currentcolor') return null;
  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6 || h.length === 8) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }
  const rgb = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (rgb) {
    return {
      r: Math.round(Number(rgb[1])),
      g: Math.round(Number(rgb[2])),
      b: Math.round(Number(rgb[3])),
      a: rgb[4] !== undefined ? Number(rgb[4]) : 1,
    };
  }
  return null;
}

function relLuminance({ r, g, b }) {
  const conv = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const R = conv(r), G = conv(g), B = conv(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function blend(fg, bg) {
  // Composite fg over bg using fg.a.
  const a = fg.a == null ? 1 : fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

export function contrastRatio(fg, bg) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!f || !b) return null;
  const fOnB = (f.a != null && f.a < 1) ? blend(f, b) : f;
  const l1 = relLuminance(fOnB);
  const l2 = relLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG AA: 4.5:1 normal, 3:1 for "large text" (>= 18.66px bold or >= 24px).
export function meetsAA(ratio, { isLargeText = false } = {}) {
  if (ratio == null) return true; // unknown — don't error on it
  return ratio >= (isLargeText ? 3 : 4.5);
}

// -- Block helpers ----------------------------------------------------------

// Resolve the text-foreground colour the block will paint with, where known.
export function blockTextColor(block) {
  if (!block) return null;
  switch (block.type) {
    case BLOCK_TYPES.HERO:
      return block.content?.textColor || '#ffffff';
    case BLOCK_TYPES.TEXT: {
      const role = block.content?.colorRole;
      if (role === 'secondary') return '#475569';
      if (role === 'tertiary') return '#64748b';
      return '#0f172a';
    }
    case BLOCK_TYPES.CARD:
      return '#0f172a';
    case BLOCK_TYPES.STAT:
      return block.content?.color || '#0f172a';
    default:
      return null;
  }
}

export function blockBackgroundColor(block) {
  if (!block) return null;
  if (block.type === BLOCK_TYPES.HERO) {
    const c = block.content || {};
    // Dark wash is applied; use bgColor when colour-mode, else fall back
    // to a dark wash assumption (black) which is the worst case for light
    // text.
    if (c.bgType === 'color' && c.bgColor) return c.bgColor;
    return '#000000';
  }
  const bg = block.style?.background;
  if (!bg || bg === 'transparent') return '#ffffff';
  return bg;
}

// Extract the rendered heading level for a block (1..6) if it produces a
// heading in the DOM, else null.
export function blockHeadingLevel(block) {
  if (!block) return null;
  const c = block.content || {};
  switch (block.type) {
    case BLOCK_TYPES.HERO: {
      const lvl = Number(c.headingLevel);
      return lvl >= 1 && lvl <= 6 ? lvl : 1;
    }
    case BLOCK_TYPES.TEXT: {
      const lvl = Number(c.headingAs);
      return lvl >= 1 && lvl <= 6 ? lvl : null;
    }
    case BLOCK_TYPES.CARD: {
      const lvl = Number(c.headingLevel);
      return lvl >= 1 && lvl <= 6 ? lvl : 3;
    }
    default:
      return null;
  }
}

// Suggest a heading level when a new block is being added to the design.
// Avoids duplicate H1s and never skips levels.
export function suggestHeadingLevel(design, newType) {
  const children = getRootChildren(design);
  const headings = children.map(blockHeadingLevel).filter((n) => n != null);
  const hasH1 = headings.includes(1);
  if (newType === BLOCK_TYPES.HERO) {
    return hasH1 ? 2 : 1;
  }
  if (newType === BLOCK_TYPES.CARD) {
    if (headings.length === 0) return 2; // first heading on page
    const maxLevel = Math.max(...headings);
    return Math.min(6, Math.max(2, maxLevel + 1));
  }
  if (newType === BLOCK_TYPES.TEXT) {
    // Text blocks render as paragraph by default. Only suggest a heading
    // level when the page already has an H1 but no H2 yet, so a follow-up
    // text block lands at the right depth without skipping.
    if (!hasH1) return null;
    if (!headings.includes(2)) return 2;
    return null;
  }
  return null;
}

// Which `content` field carries the heading level for a block type.
// Hero / Card use `headingLevel`; Text uses `headingAs` (the select that
// renders the text inside h1..h6 or p). Returns null when the block type
// has no heading control.
export function headingFieldFor(type) {
  if (type === BLOCK_TYPES.HERO || type === BLOCK_TYPES.CARD) return 'headingLevel';
  if (type === BLOCK_TYPES.TEXT) return 'headingAs';
  return null;
}

// Parse the smallest CSS pixel font-size found in a fragment of HTML by
// scanning inline `style="font-size: Npx"` declarations. Returns null
// when nothing is set.
function smallestInlineFontSize(html) {
  if (!html || typeof html !== 'string') return null;
  const re = /font-size\s*:\s*([0-9.]+)\s*px/gi;
  let m;
  let min = Infinity;
  while ((m = re.exec(html)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v < min) min = v;
  }
  return Number.isFinite(min) ? min : null;
}

// -- Rule implementations ---------------------------------------------------

function issue(blockId, blockName, rule, severity, message) {
  return { blockId, blockName, rule, severity, message };
}

function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function auditBlock(block, ctx) {
  const out = [];
  const c = block.content || {};
  const a11y = block.a11y || {};
  const name = block.name || block.type;

  // --- Image alt
  if (block.type === BLOCK_TYPES.IMAGE && c.src) {
    if (!c.alt || !String(c.alt).trim()) {
      // Decorative images may use a11y.ariaHidden=true to opt out.
      if (!a11y.ariaHidden) {
        out.push(issue(block.id, name, 'image-alt-missing', SEVERITY.ERROR,
          'Image is missing alt text. Add alt text describing the image, or mark it decorative (aria-hidden).'));
      }
    }
  }
  if (block.type === BLOCK_TYPES.CARD && c.imageUrl && !String(c.imageAlt || '').trim()) {
    out.push(issue(block.id, name, 'image-alt-missing', SEVERITY.ERROR,
      'Card image is missing alt text.'));
  }
  if (block.type === BLOCK_TYPES.LOGO_STRIP) {
    (c.logos || []).forEach((l, i) => {
      if (l?.src && !String(l.alt || '').trim()) {
        out.push(issue(block.id, name, 'image-alt-missing', SEVERITY.ERROR,
          `Logo #${i + 1} is missing alt text.`));
      }
    });
  }

  // --- Accessible names on interactive elements
  if (block.type === BLOCK_TYPES.BUTTON) {
    const visible = stripHtml(c.label);
    const aria = String(c.ariaLabel || a11y.ariaLabel || '').trim();
    if (!visible && !aria) {
      out.push(issue(block.id, name, 'button-no-accessible-name', SEVERITY.ERROR,
        'Button has no visible label or aria-label. Screen readers cannot announce it.'));
    }
  }
  if (block.type === BLOCK_TYPES.IMAGE && c.href) {
    const alt = String(c.alt || '').trim();
    const aria = String(a11y.ariaLabel || '').trim();
    if (!alt && !aria) {
      out.push(issue(block.id, name, 'link-image-no-accessible-name', SEVERITY.ERROR,
        'Image link has no accessible name. Add alt text or an aria-label.'));
    }
  }
  if (block.type === BLOCK_TYPES.ICON && a11y.ariaHidden !== true) {
    const aria = String(c.ariaLabel || a11y.ariaLabel || '').trim();
    if (!aria) {
      out.push(issue(block.id, name, 'icon-no-accessible-name', SEVERITY.WARNING,
        'Icon has no aria-label. Either add one or mark it decorative (aria-hidden).'));
    }
  }

  // --- ARIA misuse
  // Interactive block types render genuinely focusable content (a <button>,
  // a link, a form field). Marking one aria-hidden hides it from screen
  // readers while it can still be reached by keyboard — a trap. Raw tabindex
  // is no longer an author-controllable lever (reading order is pure document
  // order), so focusability is inferred from the block type instead.
  if (a11y.ariaHidden && isInteractiveBlock(block)) {
    out.push(issue(block.id, name, 'aria-hidden-focusable', SEVERITY.ERROR,
      'Element is aria-hidden but also focusable. Screen-reader users will land on an unannounced element.'));
  }

  // --- Pricing table tier CTAs / recommended exclusivity
  if (block.type === BLOCK_TYPES.PRICING_TABLE) {
    const tiers = Array.isArray(c.tiers) ? c.tiers : [];
    tiers.forEach((t, i) => {
      const label = String(t?.ctaLabel || '').trim();
      const href = String(t?.ctaHref || '').trim();
      if (label && !href) {
        out.push(issue(block.id, name, 'button-no-accessible-name', SEVERITY.ERROR,
          `Pricing tier #${i + 1} CTA "${label}" has no link target.`));
      }
      if (href && !label) {
        out.push(issue(block.id, name, 'link-image-no-accessible-name', SEVERITY.ERROR,
          `Pricing tier #${i + 1} CTA link has no visible label.`));
      }
    });
    if (tiers.filter((t) => t?.recommended).length > 1) {
      out.push(issue(block.id, name, 'pricing-multiple-recommended', SEVERITY.WARNING,
        'More than one pricing tier is marked recommended — highlight only one to guide the eye.'));
    }
    // Tier name required for the article aria-label to be meaningful.
    tiers.forEach((t, i) => {
      if (!String(t?.name || '').trim()) {
        out.push(issue(block.id, name, 'pricing-tier-missing-name', SEVERITY.ERROR,
          `Pricing tier #${i + 1} has no name — screen readers will only hear "Tier ${i + 1} pricing tier".`));
      }
    });
    // Recommended badge contrast: the badge paints primary-on-on-primary.
    // We don't know the tenant's resolved tokens at audit time, so we check
    // the design-system fallback pair (#0f172a on #ffffff in the renderer).
    // This catches the common case where an author overrides the badge label
    // but never the colour pair.
    const recIdx = tiers.findIndex((t) => t?.recommended);
    if (recIdx >= 0) {
      const ratio = contrastRatio('#ffffff', '#0f172a');
      if (!meetsAA(ratio, { isLargeText: false })) {
        out.push(issue(block.id, name, 'contrast-below-aa', SEVERITY.WARNING,
          `Recommended-tier badge contrast ${ratio?.toFixed(2)}:1 may fail WCAG AA against your branding tokens.`));
      }
    }
  }

  // --- Testimonial grid avatar alt
  if (block.type === BLOCK_TYPES.TESTIMONIAL_GRID) {
    const items = Array.isArray(c.items) ? c.items : [];
    items.forEach((t, i) => {
      if (t?.avatarUrl && !String(t.avatarAlt || '').trim()) {
        out.push(issue(block.id, name, 'image-alt-missing', SEVERITY.ERROR,
          `Testimonial #${i + 1} avatar is missing alt text. Add alt text or remove the image.`));
      }
      if (t?.companyLogoUrl && !String(t.companyLogoAlt || '').trim()) {
        out.push(issue(block.id, name, 'image-alt-missing', SEVERITY.ERROR,
          `Testimonial #${i + 1} company logo is missing alt text.`));
      }
      if (!String(t?.quote || '').trim()) {
        out.push(issue(block.id, name, 'testimonial-missing-quote', SEVERITY.WARNING,
          `Testimonial #${i + 1} has no quote text.`));
      }
    });
  }

  // --- Custom HTML — soft warning, can't audit content
  if (block.type === BLOCK_TYPES.CUSTOM_HTML) {
    out.push(issue(block.id, name, 'custom-html-unscanned', SEVERITY.INFO,
      'Custom HTML cannot be audited automatically — review manually for accessibility.'));
  }

  // --- Contrast (best-effort on blocks where both fg/bg are knowable)
  if ([BLOCK_TYPES.HERO, BLOCK_TYPES.TEXT, BLOCK_TYPES.CARD, BLOCK_TYPES.STAT].includes(block.type)) {
    const fg = blockTextColor(block);
    const bg = blockBackgroundColor(block);
    const ratio = contrastRatio(fg, bg);
    if (ratio != null) {
      // Heading-level text is generally "large"; otherwise standard.
      const isLarge = blockHeadingLevel(block) != null || block.type === BLOCK_TYPES.HERO || block.type === BLOCK_TYPES.STAT;
      if (!meetsAA(ratio, { isLargeText: isLarge })) {
        out.push(issue(block.id, name, 'contrast-below-aa',
          ratio < (isLarge ? 2.5 : 3) ? SEVERITY.ERROR : SEVERITY.WARNING,
          `Text contrast ${ratio.toFixed(2)}:1 fails WCAG AA (needs ${isLarge ? '3' : '4.5'}:1).`));
      }
    }
  }

  // --- Mobile heuristics
  const mobileGeom = resolveBlockAtBreakpoint(block, 'mobile');
  const desktopGeom = resolveBlockAtBreakpoint(block, 'desktop');

  if (mobileGeom.hidden && !desktopGeom.hidden) {
    out.push(issue(block.id, name, 'hidden-on-mobile', SEVERITY.INFO,
      'This element is hidden on mobile but visible on desktop. Make sure mobile users aren\'t missing key content.'));
  }
  if (!mobileGeom.hidden && (mobileGeom.x + mobileGeom.w) > BREAKPOINT_WIDTHS.mobile) {
    out.push(issue(block.id, name, 'overflows-mobile', SEVERITY.WARNING,
      `Element extends beyond the ${BREAKPOINT_WIDTHS.mobile}px mobile viewport — it will get clipped or force horizontal scroll.`));
  }
  if (isInteractiveBlock(block) && !mobileGeom.hidden) {
    if (mobileGeom.w < 44 || mobileGeom.h < 44) {
      out.push(issue(block.id, name, 'touch-target-too-small', SEVERITY.WARNING,
        `Interactive element is ${Math.round(mobileGeom.w)}×${Math.round(mobileGeom.h)} on mobile — minimum recommended touch target is 44×44.`));
    }
  }

  // --- Text too small on mobile (<14px is hard to read on phones)
  if (!mobileGeom.hidden && block.type === BLOCK_TYPES.TEXT) {
    const inline = smallestInlineFontSize(c.html);
    if (inline != null && inline < 14) {
      out.push(issue(block.id, name, 'mobile-text-too-small', SEVERITY.WARNING,
        `Text uses ${inline}px font-size — below the 14px minimum recommended for mobile readability.`));
    }
  }

  return out;
}

// -- Whole-document rules ---------------------------------------------------

function auditDocument(children, all) {
  const out = [];
  const headings = children
    .map((b) => ({ block: b, level: blockHeadingLevel(b) }))
    .filter((x) => x.level != null);
  const h1s = headings.filter((x) => x.level === 1);

  if (children.length > 0 && h1s.length === 0) {
    out.push(issue(null, null, 'no-h1-on-page', SEVERITY.ERROR,
      'Page has no H1 heading. Every page needs exactly one top-level heading.'));
  }
  if (h1s.length > 1) {
    for (const extra of h1s.slice(1)) {
      out.push(issue(extra.block.id, extra.block.name, 'multiple-h1', SEVERITY.WARNING,
        'Page has more than one H1. Use a single H1 and demote others to H2+.'));
    }
  }
  // Skipped heading levels (visual order, top-to-bottom by y).
  const ordered = [...headings].sort((a, b) => {
    const ga = resolveBlockAtBreakpoint(a.block, 'desktop');
    const gb = resolveBlockAtBreakpoint(b.block, 'desktop');
    return (ga.y - gb.y) || (ga.x - gb.x);
  });
  let prev = 0;
  for (const h of ordered) {
    if (prev > 0 && h.level > prev + 1) {
      out.push(issue(h.block.id, h.block.name, 'heading-level-skipped', SEVERITY.WARNING,
        `Heading jumps from H${prev} to H${h.level} — don't skip heading levels.`));
    }
    prev = h.level;
  }

  // Reading-order vs visual-order mismatch.
  // Reading order is now pure document order (raw tabindex has been retired),
  // so this flags when the document order the browser tabs through / a screen
  // reader announces differs from the top-to-bottom, left-to-right visual
  // layout. Authors resolve it with Auto-order or the reading-order arrows.
  if (!readingOrderMatchesVisual(children)) {
    out.push(issue(null, null, 'reading-order-mismatch', SEVERITY.INFO,
      'Document (tab/screen-reader) order does not match top-to-bottom visual order. Confirm this is intentional, or use Auto-order / the reading-order arrows to fix it.'));
  }
  return out;
}

// Visual order = the order a sighted user scans the page: top-to-bottom, then
// left-to-right. Sorting by desktop (y, x) with a stable index tie-break. This
// is the single source of truth reused by the audit, the heading-skip check
// and Auto-order.
export function sortChildrenByVisualOrder(children) {
  return children
    .map((block, index) => ({ block, index }))
    .sort((a, b) => {
      const ga = resolveBlockAtBreakpoint(a.block, 'desktop');
      const gb = resolveBlockAtBreakpoint(b.block, 'desktop');
      return (ga.y - gb.y) || (ga.x - gb.x) || (a.index - b.index);
    })
    .map((x) => x.block);
}

// Reading order is the document order the browser tabs through and a screen
// reader announces. Raw tabindex has been retired, so it is simply the current
// child array order.
export function computeReadingOrder(children) {
  return [...children];
}

// True when document (reading) order already matches the visual order — i.e.
// Auto-order would be a no-op.
export function readingOrderMatchesVisual(children) {
  const visual = sortChildrenByVisualOrder(children);
  for (let i = 0; i < children.length; i++) {
    if (children[i]?.id !== visual[i]?.id) return false;
  }
  return true;
}

// -- Auto reading order -----------------------------------------------------

const DEFAULT_Z_INDEX = 1;

function resolveZIndex(block) {
  const z = block?.style?.zIndex;
  return typeof z === 'number' && Number.isFinite(z) ? z : DEFAULT_Z_INDEX;
}

// Reorder every element so document (reading) order matches the visual layout
// (top-to-bottom, then left-to-right) WITHOUT changing anything visible.
//
// Absolutely-positioned blocks paint in (z-index, then document order). If we
// only reordered the array, two blocks that share a z-index and overlap could
// swap which one paints on top. To prevent any visual change we capture the
// current paint (stacking) order first, and — only when the reorder would
// otherwise change it — pin z-index explicitly so the new document order can't
// alter what renders on top.
//
// Returns a NEW array (or the same reference when already ordered) with, where
// necessary, `style.zIndex` set to preserve stacking. Pure — never mutates the
// input blocks.
export function autoOrderChildren(children) {
  if (!Array.isArray(children) || children.length <= 1) {
    return Array.isArray(children) ? [...children] : [];
  }
  // Already in visual order → nothing to do (keeps Auto-order idempotent and a
  // no-op when the page already matches).
  if (readingOrderMatchesVisual(children)) return [...children];

  // Current paint order, bottom → top: sort by (z-index, current doc index).
  const withMeta = children.map((block, index) => ({
    block,
    index,
    z: resolveZIndex(block),
  }));
  const paintOrder = [...withMeta].sort((a, b) => (a.z - b.z) || (a.index - b.index));
  const targetPaintIds = paintOrder.map((m) => m.block.id);

  const reordered = sortChildrenByVisualOrder(children);
  const newIndexById = new Map(reordered.map((b, i) => [b.id, i]));

  // Does the new document order already preserve the paint order using the
  // blocks' existing z-index values? Natural paint = sort by (z, newIndex).
  const naturalPaintIds = [...withMeta]
    .sort((a, b) => (a.z - b.z) || (newIndexById.get(a.block.id) - newIndexById.get(b.block.id)))
    .map((m) => m.block.id);
  const stackingPreserved = naturalPaintIds.every((id, i) => id === targetPaintIds[i]);
  if (stackingPreserved) return reordered;

  // Pin z-index to the current paint rank so stacking is decided purely by
  // z-index and can't be perturbed by the new document order. Only rewrite a
  // block when its resolved z-index actually changes, leaving the rest byte
  // identical.
  const zRankById = new Map(paintOrder.map((m, rank) => [m.block.id, rank + 1]));
  return reordered.map((block) => {
    const nextZ = zRankById.get(block.id);
    if (resolveZIndex(block) === nextZ) return block;
    return { ...block, style: { ...(block.style || {}), zIndex: nextZ } };
  });
}

// -- Public entry point -----------------------------------------------------

export function auditCanvasDesign(design) {
  const d = normalizeCanvasDesign(design);
  const children = getRootChildren(d);
  const issues = [];
  for (const block of children) {
    for (const it of auditBlock(block, { children })) issues.push(it);
  }
  for (const it of auditDocument(children, d)) issues.push(it);
  return issues;
}

// Issues that should block publish. Rule ids in DEFAULT_BLOCKING_RULES plus
// any rule reported at ERROR severity by default.
export function getBlockingIssues(issues, blockingRules = DEFAULT_BLOCKING_RULES) {
  return issues.filter((i) =>
    i.severity === SEVERITY.ERROR || blockingRules.has(i.rule),
  );
}

export function summarizeIssues(issues) {
  return {
    total: issues.length,
    errors: issues.filter((i) => i.severity === SEVERITY.ERROR).length,
    warnings: issues.filter((i) => i.severity === SEVERITY.WARNING).length,
    info: issues.filter((i) => i.severity === SEVERITY.INFO).length,
  };
}

// Per-block lookup useful for inline badges. Returns Map<blockId, issues[]>.
export function issuesByBlock(issues) {
  const map = new Map();
  for (const i of issues) {
    if (!i.blockId) continue;
    const arr = map.get(i.blockId) || [];
    arr.push(i);
    map.set(i.blockId, arr);
  }
  return map;
}

export function worstSeverity(arr) {
  if (!arr || arr.length === 0) return null;
  if (arr.some((i) => i.severity === SEVERITY.ERROR)) return SEVERITY.ERROR;
  if (arr.some((i) => i.severity === SEVERITY.WARNING)) return SEVERITY.WARNING;
  return SEVERITY.INFO;
}
