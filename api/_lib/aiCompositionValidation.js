/**
 * AI Composition render-time validation — Phase 4 (Task #2852, spec §13
 * stages 7–8, §21–23, §30).
 *
 * Pure document-level checks executed against all three breakpoints before a
 * version is stored / a proposal is accepted. Complements (does not replace)
 * the schema/security validator in aiCompositionSchema.js.
 *
 * Result shape (stored on ai_composition_version.validation_result):
 *   { ok, critical: Issue[], warnings: Issue[], checks: string[], checkedAt }
 *   Issue: { check, severity: 'critical'|'warning', message, elementId?,
 *            sectionId?, breakpoint? }
 *
 * Severity policy (spec §21/§23): missing alt text, unlabeled interactive
 * elements and detectable contrast failures are CRITICAL and block
 * approval/insertion. Overflow, heading order, responsive coverage, missing
 * assets, broken/unresolved links and parent-flow issues are warnings the
 * author reviews in the preview.
 */

import { validateComposition } from './aiCompositionSchema.js';

export const VALIDATION_BREAKPOINT_WIDTHS = { desktop: 1200, tablet: 768, mobile: 375 };

const IMAGE_TYPES = new Set(['image', 'generated_illustration']);
const INTERACTIVE_TYPES = new Set(['button', 'text_link']);

function textOf(el) {
  const c = el?.content || {};
  const raw = c.text || c.label || (typeof c.html === 'string' ? c.html.replace(/<[^>]+>/g, ' ') : '');
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function walk(doc, fn) {
  for (const section of doc?.sections || []) {
    const visit = (els, parents) => {
      for (const el of els || []) {
        if (!el || typeof el !== 'object') continue;
        fn(el, section, parents);
        if (Array.isArray(el.children)) visit(el.children, [...parents, el]);
      }
    };
    visit(section.elements, []);
  }
}

// ---------------------------------------------------------------------------
// Colour parsing + WCAG contrast
// ---------------------------------------------------------------------------

export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
    };
  }
  m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  const NAMED = { white: '#ffffff', black: '#000000' };
  if (NAMED[v]) return parseColor(NAMED[v]);
  return null; // gradients / css vars / named colours we don't resolve
}

function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function fontSizePx(style) {
  const m = String(style?.fontSize || '').match(/^([\d.]+)\s*px$/);
  return m ? Number(m[1]) : 16;
}

function isBold(style) {
  const w = style?.fontWeight;
  return w === 'bold' || Number(w) >= 700;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkAltText(doc, issues) {
  walk(doc, (el, section) => {
    if (!IMAGE_TYPES.has(el.type)) return;
    if (el.asset?.decorative === true) return;
    const alt = (el.asset?.altText || el.imageBrief?.accessibilityDescription || '').trim();
    if (!alt) {
      issues.push({
        check: 'alt_text', severity: 'critical',
        message: 'Image is missing alt text (and is not marked decorative).',
        elementId: el.id, sectionId: section.id,
      });
    }
  });
}

function checkKeyboard(doc, issues) {
  walk(doc, (el, section) => {
    if (!INTERACTIVE_TYPES.has(el.type)) return;
    if (!textOf(el)) {
      issues.push({
        check: 'keyboard', severity: 'critical',
        message: `${el.type === 'button' ? 'Button' : 'Link'} has no accessible label text.`,
        elementId: el.id, sectionId: section.id,
      });
    }
  });
}

function checkContrast(doc, issues) {
  walk(doc, (el, section, parents) => {
    const fg = parseColor(el.style?.color);
    if (!fg) return;
    // Nearest resolvable ancestor background (element → parents → section bg element).
    let bg = parseColor(el.style?.backgroundColor);
    if (!bg) {
      for (let i = parents.length - 1; i >= 0 && !bg; i -= 1) {
        bg = parseColor(parents[i].style?.backgroundColor);
      }
    }
    if (!bg) {
      const bgEl = (section.elements || []).find((e) => e?.type === 'background' || e?.type === 'section_background');
      bg = parseColor(bgEl?.style?.backgroundColor);
    }
    if (!bg) return; // cannot resolve — skip rather than guess
    const ratio = contrastRatio(fg, bg);
    const size = fontSizePx(el.style);
    const large = size >= 24 || (size >= 18.66 && isBold(el.style));
    const required = large ? 3 : 4.5;
    if (ratio < required) {
      issues.push({
        check: 'contrast', severity: 'critical',
        message: `Text contrast ${ratio.toFixed(2)}:1 is below the required ${required}:1.`,
        elementId: el.id, sectionId: section.id,
      });
    }
  });
}

function checkHeadingOrder(doc, issues) {
  let last = 0;
  for (const section of doc?.sections || []) {
    const byId = new Map((section.elements || []).map((e) => [e?.id, e]));
    const order = Array.isArray(section.readingOrder) ? section.readingOrder : [];
    for (const id of order) {
      const el = byId.get(id);
      if (!el || el.type !== 'heading') continue;
      const level = Number(String(el.role || 'h2').replace('h', '')) || 2;
      if (last > 0 && level > last + 1) {
        issues.push({
          check: 'heading_order', severity: 'warning',
          message: `Heading level jumps from h${last} to h${level}.`,
          elementId: el.id, sectionId: section.id,
        });
      }
      last = level;
    }
  }
}

function checkMissingAssets(doc, issues) {
  walk(doc, (el, section) => {
    if (!IMAGE_TYPES.has(el.type)) return;
    const a = el.asset;
    if (a?.status === 'failed') {
      issues.push({
        check: 'missing_asset', severity: 'warning',
        message: 'Image generation failed for this element — retry or replace it.',
        elementId: el.id, sectionId: section.id,
      });
    } else if (!a?.fileRepositoryId && !el.imageBrief && a?.status !== 'pending') {
      issues.push({
        check: 'missing_asset', severity: 'warning',
        message: 'Image element has no asset and no generation brief.',
        elementId: el.id, sectionId: section.id,
      });
    }
  });
}

function checkOverflow(doc, issues) {
  for (const [bp, width] of Object.entries(VALIDATION_BREAKPOINT_WIDTHS)) {
    const layout = doc?.layouts?.[bp];
    const desktop = doc?.layouts?.desktop || {};
    walk(doc, (el, section) => {
      const frame = (layout && layout[el.id]) || desktop[el.id];
      if (!frame || frame.visible === false) return;
      const x = Number(frame.x) || 0;
      const w = Number(frame.w) || 0;
      if (w > 0 && x + w > width + 1) {
        issues.push({
          check: 'overflow', severity: 'warning', breakpoint: bp,
          message: `Element extends past the ${bp} canvas width (${Math.round(x + w)}px > ${width}px).`,
          elementId: el.id, sectionId: section.id,
        });
      }
    });
  }
}

function checkResponsive(doc, issues) {
  const desktop = doc?.layouts?.desktop || {};
  const mobile = doc?.layouts?.mobile || {};
  const mobileWidth = VALIDATION_BREAKPOINT_WIDTHS.mobile;
  walk(doc, (el, section) => {
    const d = desktop[el.id];
    if (!d || d.visible === false) return;
    const w = Number(d.w) || 0;
    if (w > mobileWidth && !mobile[el.id]) {
      issues.push({
        check: 'responsive', severity: 'warning', breakpoint: 'mobile',
        message: 'Element is wider than the mobile canvas but has no mobile layout override.',
        elementId: el.id, sectionId: section.id,
      });
    }
  });
}

function checkParentFlow(doc, issues) {
  // The parent Canvas needs a computable height for every section at every
  // breakpoint: at least one element frame must yield a numeric bottom edge.
  for (const section of doc?.sections || []) {
    for (const bp of Object.keys(VALIDATION_BREAKPOINT_WIDTHS)) {
      const layout = doc?.layouts?.[bp] || {};
      const desktop = doc?.layouts?.desktop || {};
      let bottom = 0;
      for (const el of section.elements || []) {
        const f = layout[el?.id] || desktop[el?.id];
        if (!f || f.visible === false) continue;
        const y = Number(f.y) || 0;
        const h = Number(f.h ?? f.minH) || 0;
        if (h > 0) bottom = Math.max(bottom, y + h);
      }
      if (bottom <= 0) {
        issues.push({
          check: 'parent_flow', severity: 'warning', breakpoint: bp,
          message: `Section height cannot be computed at ${bp} — parent page reflow may be wrong.`,
          sectionId: section.id,
        });
        break; // one flag per section is enough
      }
    }
  }
}

function checkUnresolvedLinks(doc, issues, brokenLinks = []) {
  for (const b of brokenLinks) {
    issues.push({
      check: 'broken_link', severity: 'warning',
      message: `Link destination (${b.kind}) no longer exists in this organisation.`,
      elementId: b.elementId,
    });
  }
}

// ---------------------------------------------------------------------------

export const VALIDATION_CHECKS = [
  'schema', 'security', 'alt_text', 'keyboard', 'contrast', 'heading_order',
  'missing_asset', 'broken_link', 'overflow', 'responsive', 'parent_flow',
];

/**
 * Run the full render-time validation over a composition document.
 * `brokenLinks` is optionally pre-computed by the caller (needs DB access).
 */
export function runCompositionValidation(doc, { brokenLinks = [] } = {}) {
  const issues = [];
  const schema = validateComposition(doc);
  if (!schema.ok) {
    for (const e of schema.errors.slice(0, 25)) {
      issues.push({ check: 'schema', severity: 'critical', message: e });
    }
  } else {
    checkAltText(doc, issues);
    checkKeyboard(doc, issues);
    checkContrast(doc, issues);
    checkHeadingOrder(doc, issues);
    checkMissingAssets(doc, issues);
    checkOverflow(doc, issues);
    checkResponsive(doc, issues);
    checkParentFlow(doc, issues);
    checkUnresolvedLinks(doc, issues, brokenLinks);
  }
  const critical = issues.filter((i) => i.severity === 'critical');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return {
    ok: critical.length === 0,
    critical,
    warnings,
    checks: VALIDATION_CHECKS,
    breakpoints: Object.keys(VALIDATION_BREAKPOINT_WIDTHS),
    checkedAt: new Date().toISOString(),
  };
}

/** Human summary for API responses / conversation records. */
export function summarizeValidation(result) {
  if (!result) return 'Not validated.';
  if (result.ok && result.warnings.length === 0) return 'All checks passed.';
  const parts = [];
  if (result.critical?.length) parts.push(`${result.critical.length} critical issue(s)`);
  if (result.warnings?.length) parts.push(`${result.warnings.length} warning(s)`);
  return parts.join(', ') || 'All checks passed.';
}
