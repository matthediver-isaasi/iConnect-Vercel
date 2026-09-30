// Lightweight client-side extraction of a Canvas page's key brand colours, used
// to render a small swatch hint next to each "Match the style of" seed option in
// the doc-import dialog. This mirrors the colour picks in the server-side
// `extractThemeFromDesign` (api/_lib/canvasLayoutEngine.js) so the hint reflects
// the same style extraction that will actually be applied when generating a page.
// It intentionally only pulls the few colours needed for a visual cue rather
// than the full theme/typography object.

const isRealColor = (v) => typeof v === 'string' && v.trim() !== '';

function collectDesignBlocks(design) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.type && node.content) out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(visit);
    if (Array.isArray(node.sections)) node.sections.forEach(visit);
  };
  const root = design && typeof design === 'object' ? design.root : null;
  if (root && Array.isArray(root.sections)) root.sections.forEach(visit);
  return out;
}

// Returns an ordered, deduped array of CSS colour strings (accent, hero, band)
// describing a seed page's look, or [] when the design has nothing usable.
// Colour values may be CSS custom-property references (e.g.
// `var(--cb-color-primary, #2563eb)`); these render fine as swatch backgrounds
// and fall back to their literal default outside the Canvas runtime.
export function extractSeedSwatches(design) {
  const blocks = collectDesignBlocks(design);
  if (!blocks.length) return [];

  const swatches = { accent: null, hero: null, band: null };

  // --- Hero overlay colour. ---
  const hero = blocks.find((b) => b.type === 'hero');
  if (hero?.content) {
    const c = hero.content;
    const firstStop =
      Array.isArray(c.overlayStops) && c.overlayStops.length ? c.overlayStops[0]?.color : null;
    if (isRealColor(c.overlayFromColor)) swatches.hero = c.overlayFromColor;
    else if (isRealColor(firstStop)) swatches.hero = firstStop;
  }

  // --- Colour band background. ---
  const section = blocks.find((b) => b.type === 'section');
  if (isRealColor(section?.style?.background)) swatches.band = section.style.background;

  // --- Accent: first real colour among icon / bullet / card-icon colours. ---
  let accent = null;
  for (const b of blocks) {
    const c = b.content || {};
    if (b.type === 'image' && isRealColor(c.iconColor) && isRealColor(c.iconClass)) {
      accent = c.iconColor;
      break;
    }
    if (b.type === 'text' && isRealColor(c.bulletIconColor)) {
      accent = c.bulletIconColor;
      break;
    }
    if (b.type === 'card' && isRealColor(c.iconColor)) {
      accent = c.iconColor;
      break;
    }
  }
  if (!accent) {
    const card = blocks.find((b) => b.type === 'card');
    if (isRealColor(card?.content?.highlightColor)) accent = card.content.highlightColor;
  }
  if (!accent) {
    const divider = blocks.find((b) => b.type === 'divider');
    if (isRealColor(divider?.content?.color)) accent = divider.content.color;
  }
  if (isRealColor(accent)) swatches.accent = accent;

  const ordered = [swatches.accent, swatches.hero, swatches.band].filter(isRealColor);
  return Array.from(new Set(ordered));
}
