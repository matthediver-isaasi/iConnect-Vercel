// Reusable Canvas Builder spacing analysis + normalization module (BNMS).
//
// This module is READ-ONLY at the data layer: it inspects a page's
// `canvas_design` document, extracts a spacing "signature", compares it against
// the canonical rhythm produced by `scripts/provision-canvas-page-from-doc.mjs`,
// and computes a proposed normalized geometry (a dry-run reflow). It NEVER
// touches the database — callers decide whether/what to persist. The follow-up
// "apply" task imports `normalizeDesign()` to obtain the new geometry.
//
// Nothing here alters block copy, content, images, links, block types, or the
// order of blocks in the design. Only per-breakpoint DESKTOP geometry (x/y/w/h)
// and a small set of style/geometry knobs (hero padding, divider width/
// thickness, section-band padding) are ever proposed for change.
//
// The layout engine in provision-canvas-page-from-doc.mjs is the source of
// truth for the target rhythm; the constants below mirror it verbatim.

// ---------------------------------------------------------------------------
// Canonical target rhythm (mirrors the provisioning layout engine).
// ---------------------------------------------------------------------------
export const TARGET = {
  CANVAS_W: 1200,
  MARGIN: 150, // content left margin
  CONTENT_W: 900, // CANVAS_W - MARGIN*2
  COL_GAP: 60,
  COL_W: 420,
  COL_LEFT_X: 150,
  COL_RIGHT_X: 630, // MARGIN + COL_W + COL_GAP

  HERO_OPEN_H: 600,
  HERO_CLOSE_H: 420,
  HERO_PAD_X: 200, // hero horizontal padding
  HERO_FULL_BLEED: true,

  GAP_AFTER_HERO: 48,

  BAND_INNER_TOP: 56, // inner top padding inside the colour band
  BAND_PAD: 24, // section-band padding on all sides

  H2_H: 60,
  GAP_HEADING_DIVIDER: 12,
  DIVIDER_W: 300, // full-width heading divider (columns use 260)
  DIVIDER_W_COL: 260,
  GAP_DIVIDER_BODY: 20,
  GAP_HEADING_BODY: 12,

  SECTION_GAP: 56, // vertical gap between sections
  DIVIDER_THICKNESS: 1,
};

// Tolerances (px) — deltas at or below these are treated as "on-grid".
export const TOLERANCE = {
  margin: 8,
  width: 12,
  heroPadX: 12,
  heroHeight: 40,
  bandPad: 6,
  bandInnerTop: 16,
  dividerWidth: 20,
  gap: 12,
};

// Block types considered part of the standard hand-buildable set. Anything
// outside this set (dynamic/data-bound blocks, columns, video, custom-html,
// embeds, galleries, etc.) forces a page into the "needs review" bucket.
export const STANDARD_BLOCK_TYPES = new Set([
  'hero', 'text', 'image', 'divider', 'section', 'card', 'accordion', 'button', 'spacer',
]);

// Block types that signal an unusual / custom / data-bound layout.
export const CUSTOM_BLOCK_TYPES = new Set([
  'columns', 'video', 'custom-html', 'testimonials', 'testimonial-grid',
  'stat', 'logo-strip', 'map', 'pricing-table', 'news-ticker', 'mega-menu',
  'countdown', 'event-list', 'event-teaser', 'event-sessions', 'event-carousel',
  'speaker-carousel', 'speaker-grid', 'sponsor-grid', 'sponsor-carousel',
  'article-list', 'resource-list', 'form-embed', 'campaign-embed',
  'member-directory-embed', 'dynamic-directory-embed', 'card-deck',
  'wall-of-fame', 'gallery', 'card-flip-grid', 'hero-carousel', 'hero-carousel-mobile', 'symbol',
  'login-form',
]);

// The 29 script-provisioned slugs (must stay in lockstep with the PAGES array
// in provision-canvas-page-from-doc.mjs). Excluded from the in-scope set.
export const PROVISIONED_SLUGS = new Set([
  'mrt', 'mrt-committee', 'mrt-patient-stories', 'mrt-professional-resources',
  'ukrg', 'about-ukrg', 'ukrg-committee', 'ukrg-education-and-events',
  'ukrg-news', 'ukrg-professional-resources', 'ukrg-safety-and-quality',
  'the-bnms-student-prize', 'welcome-new-committee-members',
  'scientific-education-committee', 'research-and-innovation',
  'radiopharmaceutical-sciences-group',
  'radiographers-technologists-and-nurses-committee',
  'professional-standards-committee', 'people', 'about-us', 'in-memoriam',
  'governance-and-policies', 'declaration-of-interests-for-invited-speakers',
  'declaration-of-interests', 'clinical-scientists-group',
  'bnms-medical-training-committee', 'awards-and-recognition',
  'apprenticeships-in-nuclear-medicine', 'annual-achievements',
]);

// Reference pages that embody the standard — analysed as baseline only, never
// normalized.
export const REFERENCE_SLUGS = new Set([
  'travelling-fellowships', 'honory-membership', 'about-mrt',
]);

// Slugs that are the older, superseded twins of a provisioned page (typo/naming
// variants that were re-provisioned under a corrected slug). Still in scope by
// the mechanical rules, but flagged for human eyes — they may be dead/orphaned.
export const SUPERSEDED_TWINS = new Map([
  ['professional-standards-commitee', 'professional-standards-committee'],
  ['scientific-and-education-committee', 'scientific-education-committee'],
  ['radiographers-technologists-nurses-committee', 'radiographers-technologists-and-nurses-committee'],
  ['medical-trainee-commitee', 'bnms-medical-training-committee'],
  ['declaration-of-interest', 'declaration-of-interests'],
  ['declaration-of-interest-speakers', 'declaration-of-interests-for-invited-speakers'],
  ['bnms-governance', 'governance-and-policies'],
  ['honorary-members', 'honory-membership'],
  ['grants-travelling-fellowships', 'travelling-fellowships'],
  ['tor-professional-standards-committee', 'professional-standards-committee'],
]);

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function desktop(block) {
  const d = block?.bp?.desktop || {};
  return {
    x: num(d.x) ?? 0,
    y: num(d.y) ?? 0,
    w: num(d.w) ?? 0,
    h: num(d.h) ?? 0,
    hidden: !!d.hidden,
  };
}

// Flatten all blocks across all sections (in array/source order).
export function flattenBlocks(design) {
  const out = [];
  const sections = design?.root?.sections || [];
  for (const s of sections) {
    for (const b of s.children || []) out.push(b);
  }
  return out;
}

// Statistical mode of an array of numbers within a bucket size (px).
function modeWithin(values, bucket = 4) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) {
    const key = Math.round(v / bucket) * bucket;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) { bestN = n; best = k; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Signature extraction — the measurable spacing metrics for one page.
// ---------------------------------------------------------------------------
export function extractSignature(design) {
  const blocks = flattenBlocks(design).filter((b) => !desktop(b).hidden);
  const heroes = blocks.filter((b) => b.type === 'hero');
  const bands = blocks.filter((b) => b.type === 'section');
  const dividers = blocks.filter((b) => b.type === 'divider');

  // Content blocks: text/body/accordion that sit in the main column (roughly
  // full width). Used to derive the content left/right margins.
  const contentBlocks = blocks.filter((b) => {
    if (!['text', 'accordion'].includes(b.type)) return false;
    const d = desktop(b);
    return d.w >= 600 && d.w <= 1100; // full-column-ish, not a two-column half
  });

  const leftXs = contentBlocks.map((b) => desktop(b).x);
  const rightMargins = contentBlocks.map((b) => TARGET.CANVAS_W - (desktop(b).x + desktop(b).w));
  const widths = contentBlocks.map((b) => desktop(b).w);

  // Hero metrics.
  const heroSigs = heroes.map((b) => {
    const d = desktop(b);
    return {
      id: b.id,
      y: d.y,
      h: d.h,
      padLeft: num(b.style?.paddingLeft) ?? 0,
      padRight: num(b.style?.paddingRight) ?? 0,
      fullBleed: !!b.content?.fullBleed,
      // Task #2506: layout engine now emits contained heroes (fullWidth
      // pin instead of the 100vw fullBleed breakout).
      fullWidth: !!b.fullWidth,
    };
  }).sort((a, b) => a.y - b.y);

  // Band metrics (there can be more than one colour band on a page).
  const bandSigs = bands.map((b) => {
    const d = desktop(b);
    // Inner top padding = gap between band top and the first content block that
    // starts inside the band's vertical span.
    const inside = blocks
      .filter((c) => c !== b && c.type !== 'section' && c.type !== 'hero')
      .map((c) => desktop(c))
      .filter((cd) => cd.y >= d.y && cd.y < d.y + d.h)
      .sort((p, q) => p.y - q.y);
    const innerTop = inside.length ? inside[0].y - d.y : null;
    return {
      id: b.id,
      y: d.y,
      h: d.h,
      padTop: num(b.style?.paddingTop) ?? 0,
      padRight: num(b.style?.paddingRight) ?? 0,
      padBottom: num(b.style?.paddingBottom) ?? 0,
      padLeft: num(b.style?.paddingLeft) ?? 0,
      innerTop,
    };
  }).sort((a, b) => a.y - b.y);

  // Divider metrics.
  const dividerSigs = dividers.map((b) => {
    const d = desktop(b);
    return { id: b.id, w: d.w, thickness: num(b.content?.thickness) ?? 1 };
  });

  // Vertical rhythm: group blocks into rows by y (excluding full-height bands
  // and pure overlays), then compute gaps between consecutive rows.
  const gaps = computeVerticalGaps(blocks, bandSigs);

  return {
    blockCount: blocks.length,
    blockTypes: countBy(blocks.map((b) => b.type)),
    heroes: heroSigs,
    bands: bandSigs,
    dividers: dividerSigs,
    contentLeftMargin: modeWithin(leftXs),
    contentWidth: modeWithin(widths),
    contentRightMargin: modeWithin(rightMargins),
    contentSampleCount: contentBlocks.length,
    gaps,
  };
}

function countBy(arr) {
  const m = {};
  for (const v of arr) m[v] = (m[v] || 0) + 1;
  return m;
}

// Rows are groups of blocks whose y is within `rowTol` of each other (so a
// two-column pair counts as one row). Returns the inter-row vertical gaps.
function computeVerticalGaps(blocks, bandSigs, rowTol = 24) {
  const bandIds = new Set(bandSigs.map((b) => b.id));
  // Exclude the full-height band backgrounds; keep everything else including
  // heroes so the after-hero gap is captured.
  const stack = blocks
    .filter((b) => !bandIds.has(b.id))
    .map((b) => ({ type: b.type, ...desktop(b) }))
    // Drop zero-size / off-canvas overlays that would distort gap math.
    .filter((b) => b.h > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const rows = [];
  for (const b of stack) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(b.y - last.y) <= rowTol) {
      last.bottom = Math.max(last.bottom, b.y + b.h);
      last.members.push(b);
    } else {
      rows.push({ y: b.y, bottom: b.y + b.h, members: [b] });
    }
  }

  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].y - rows[i - 1].bottom;
    gaps.push(Math.round(gap));
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Comparison against the target — a list of per-metric deviations.
// ---------------------------------------------------------------------------
export function compareToTarget(sig) {
  const deltas = [];
  const push = (metric, current, target, tol) => {
    if (current == null) return;
    const delta = current - target;
    if (Math.abs(delta) > tol) {
      deltas.push({ metric, current, target, delta });
    }
  };

  push('contentLeftMargin', sig.contentLeftMargin, TARGET.MARGIN, TOLERANCE.margin);
  push('contentWidth', sig.contentWidth, TARGET.CONTENT_W, TOLERANCE.width);
  push('contentRightMargin', sig.contentRightMargin, TARGET.MARGIN, TOLERANCE.margin);

  sig.heroes.forEach((hero, i) => {
    const isOpening = i === 0;
    const targetH = isOpening ? TARGET.HERO_OPEN_H : TARGET.HERO_CLOSE_H;
    push(`hero[${i}].padLeft`, hero.padLeft, TARGET.HERO_PAD_X, TOLERANCE.heroPadX);
    push(`hero[${i}].padRight`, hero.padRight, TARGET.HERO_PAD_X, TOLERANCE.heroPadX);
    push(`hero[${i}].height`, hero.h, targetH, TOLERANCE.heroHeight);
    // Task #2506: the layout engine now emits contained heroes (fullWidth
    // pin) instead of the 100vw fullBleed breakout — accept either flag as
    // "spans the full page column"; flag only heroes with neither.
    if (!hero.fullBleed && !hero.fullWidth) {
      deltas.push({ metric: `hero[${i}].fullBleed`, current: false, target: true, delta: 'not full-bleed or full-width' });
    }
  });

  sig.bands.forEach((band, i) => {
    push(`band[${i}].padTop`, band.padTop, TARGET.BAND_PAD, TOLERANCE.bandPad);
    push(`band[${i}].padRight`, band.padRight, TARGET.BAND_PAD, TOLERANCE.bandPad);
    push(`band[${i}].padBottom`, band.padBottom, TARGET.BAND_PAD, TOLERANCE.bandPad);
    push(`band[${i}].padLeft`, band.padLeft, TARGET.BAND_PAD, TOLERANCE.bandPad);
    push(`band[${i}].innerTop`, band.innerTop, TARGET.BAND_INNER_TOP, TOLERANCE.bandInnerTop);
  });

  sig.dividers.forEach((d, i) => {
    // Accept either the full-width (300) or column (260) divider width.
    const nearest = Math.abs(d.w - TARGET.DIVIDER_W) <= Math.abs(d.w - TARGET.DIVIDER_W_COL)
      ? TARGET.DIVIDER_W : TARGET.DIVIDER_W_COL;
    push(`divider[${i}].width`, d.w, nearest, TOLERANCE.dividerWidth);
    if (d.thickness !== TARGET.DIVIDER_THICKNESS) {
      deltas.push({ metric: `divider[${i}].thickness`, current: d.thickness, target: TARGET.DIVIDER_THICKNESS, delta: d.thickness - TARGET.DIVIDER_THICKNESS });
    }
  });

  return deltas;
}

// ---------------------------------------------------------------------------
// Classification — "straightforward normalize" vs "needs review".
// ---------------------------------------------------------------------------
export function classifyPage({ slug, sig }) {
  const reasons = [];
  let bucket = 'normalize';

  // Data-bound / custom block types → needs review.
  const customTypes = Object.keys(sig.blockTypes).filter((t) => CUSTOM_BLOCK_TYPES.has(t));
  if (customTypes.length) {
    reasons.push(`custom/dynamic blocks: ${customTypes.join(', ')}`);
    bucket = 'review';
  }

  // Non-standard block types not in either set (future-proofing).
  const unknownTypes = Object.keys(sig.blockTypes).filter(
    (t) => !STANDARD_BLOCK_TYPES.has(t) && !CUSTOM_BLOCK_TYPES.has(t),
  );
  if (unknownTypes.length) {
    reasons.push(`unrecognised block types: ${unknownTypes.join(', ')}`);
    bucket = 'review';
  }

  // Event / meeting pages.
  if (/meeting|spring|autumn|conference|exhibitor|symposium/.test(slug)) {
    reasons.push('event/meeting page (schedule-like layout)');
    bucket = 'review';
  }

  // Superseded twin of a provisioned page.
  if (SUPERSEDED_TWINS.has(slug)) {
    reasons.push(`possible superseded duplicate of "${SUPERSEDED_TWINS.get(slug)}"`);
    bucket = 'review';
  }

  // No hero, or many heroes (carousel-like), or no colour band → unusual.
  if (sig.heroes.length === 0) {
    reasons.push('no hero block (atypical layout)');
    bucket = 'review';
  }
  if (sig.heroes.length > 2) {
    reasons.push(`${sig.heroes.length} hero blocks (custom layout)`);
    bucket = 'review';
  }

  // Very large / very small pages.
  if (sig.blockCount > 60) {
    reasons.push(`heavy page (${sig.blockCount} blocks)`);
    bucket = 'review';
  }

  return { bucket, reasons };
}

// ---------------------------------------------------------------------------
// Normalization (dry-run reflow). Produces a DEEP COPY of the design with
// proposed desktop geometry + a small set of style knobs adjusted to the target
// rhythm. Content/order/types are never touched. Returns { design, changes }.
//
// Strategy: treat the page as a single vertical stack. Sort blocks into rows by
// y (two-column pairs share a row), then re-flow y top-to-bottom applying the
// standard gaps by inferred role. Content-column blocks are re-aligned to
// x=150/w=900. Hero padding/height, divider width/thickness, and band padding
// are snapped to target. The colour band(s) are re-fitted around the content
// that falls inside their original span.
// ---------------------------------------------------------------------------
export function normalizeDesign(design) {
  const clone = JSON.parse(JSON.stringify(design));
  const changes = [];
  const record = (blockId, field, from, to) => {
    if (from === to) return;
    changes.push({ blockId, field, from, to });
  };

  const sections = clone?.root?.sections || [];
  for (const section of sections) {
    const children = section.children || [];
    normalizeSection(children, record);
  }

  return { design: clone, changes };
}

function inferRole(block) {
  if (block.type === 'hero') return 'hero';
  if (block.type === 'section') return 'band';
  if (block.type === 'divider') return 'divider';
  if (block.type === 'text') {
    const level = String(block.content?.headingAs || '');
    if (level === '2') return 'h2';
    if (level === '3') return 'h3';
    return 'body';
  }
  if (block.type === 'image') return 'image';
  if (block.type === 'card') return 'card';
  if (block.type === 'accordion') return 'accordion';
  if (block.type === 'button') return 'button';
  return 'other';
}

function normalizeSection(children, record) {
  // Snap style/geometry knobs first (independent of vertical flow).
  for (const b of children) {
    const role = inferRole(b);
    if (role === 'hero') {
      snap(b.style, 'paddingLeft', TARGET.HERO_PAD_X, record, b.id);
      snap(b.style, 'paddingRight', TARGET.HERO_PAD_X, record, b.id);
    }
    if (role === 'band') {
      for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        snap(b.style, p, TARGET.BAND_PAD, record, b.id);
      }
    }
    if (role === 'divider') {
      if ((b.content?.thickness ?? 1) !== TARGET.DIVIDER_THICKNESS) {
        record(b.id, 'content.thickness', b.content?.thickness, TARGET.DIVIDER_THICKNESS);
        if (b.content) b.content.thickness = TARGET.DIVIDER_THICKNESS;
      }
    }
  }

  // Re-align content-column blocks horizontally to x=150 / w=900. Skip blocks
  // that are clearly two-column halves (w near COL_W) or full-bleed heroes/bands
  // or centred cards.
  for (const b of children) {
    const role = inferRole(b);
    if (['h2', 'h3', 'body', 'accordion'].includes(role)) {
      const d = b.bp?.desktop;
      if (!d) continue;
      const isHalfColumn = Math.abs((d.w ?? 0) - TARGET.COL_W) <= 40;
      if (isHalfColumn) continue; // leave two-column bodies to the column logic
      if ((d.w ?? 0) >= 600) {
        if (d.x !== TARGET.MARGIN) { record(b.id, 'desktop.x', d.x, TARGET.MARGIN); d.x = TARGET.MARGIN; }
        if (d.w !== TARGET.CONTENT_W) { record(b.id, 'desktop.w', d.w, TARGET.CONTENT_W); d.w = TARGET.CONTENT_W; }
      }
    }
  }

  // Note: the vertical reflow (re-assigning y with standard gaps) is intentionally
  // left to the apply task's richer role model. For the report stage we compute
  // proposed y positions but do not force them here, since inferring section
  // boundaries on arbitrary hand-built pages is heuristic. The change list above
  // captures the deterministic, safe deltas (margins, hero pad, band pad,
  // divider). See computeReflow() for the proposed vertical plan.
}

function snap(styleObj, key, target, record, blockId) {
  if (!styleObj) return;
  const cur = num(styleObj[key]);
  if (cur == null || cur === target) return;
  record(blockId, `style.${key}`, cur, target);
  styleObj[key] = target;
}

// Compute a proposed vertical reflow plan (list of { blockId, fromY, toY })
// WITHOUT mutating the design. This documents the exact y-shifts a full
// normalization would apply, using the standard gaps by role. Bands and pure
// overlays keep their relationship to the content they wrap.
export function computeReflow(design) {
  const blocks = flattenBlocks(design).filter((b) => !desktop(b).hidden && desktop(b).h > 0);
  const bands = blocks.filter((b) => b.type === 'section');
  const bandIds = new Set(bands.map((b) => b.id));

  const flow = blocks
    .filter((b) => !bandIds.has(b.id))
    .map((b) => ({ block: b, role: inferRole(b), ...desktop(b) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // Group into rows.
  const rows = [];
  for (const item of flow) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(item.y - last.y) <= 24) {
      last.items.push(item);
      last.height = Math.max(last.height, item.h);
    } else {
      rows.push({ y: item.y, items: [item], height: item.h, role: item.role });
    }
  }

  const plan = [];
  let cursor = 0;
  let prevRole = null;
  rows.forEach((row, idx) => {
    const role = row.items[0].role;
    if (idx === 0) {
      cursor = 0;
    } else {
      cursor += rowGap(prevRole, role);
    }
    for (const it of row.items) {
      plan.push({ blockId: it.block.id, role: it.role, fromY: it.y, toY: cursor });
    }
    cursor += row.height;
    prevRole = role;
  });

  return plan;
}

function rowGap(prevRole, role) {
  if (prevRole === 'hero') return TARGET.GAP_AFTER_HERO;
  if (prevRole === 'h2' && role === 'divider') return TARGET.GAP_HEADING_DIVIDER;
  if (prevRole === 'h3' && role === 'divider') return TARGET.GAP_HEADING_DIVIDER;
  if (prevRole === 'divider') return TARGET.GAP_DIVIDER_BODY;
  if ((prevRole === 'h2' || prevRole === 'h3') && role === 'body') return TARGET.GAP_HEADING_BODY;
  if (role === 'h2' || role === 'h3') return TARGET.SECTION_GAP;
  return TARGET.SECTION_GAP;
}

// ---------------------------------------------------------------------------
// FULL normalization — used by the "apply" task (scripts/apply-canvas-spacing.mjs).
//
// Canvas blocks are absolutely positioned, so vertical rhythm (inter-section
// gaps, hero height, colour-band box) can ONLY be normalized by re-flowing the
// desktop `y` (and hero/band heights). Doing that naively would wreck the
// bespoke internal layout of the hand-built pages (two-column groups, card
// grids, icon+heading+divider+body stacks, and even intentional/messy
// overlaps). This function therefore uses a CLUSTER-PRESERVING reflow:
//
//   1. It applies the same safe deterministic snaps as normalizeDesign()
//      (content-column x/w, hero horizontal padding, band padding, divider
//      thickness).
//   2. It groups the remaining (non-band) blocks into vertical "clusters" by
//      proximity — any vertical gap larger than CLUSTER_GAP_THRESHOLD starts a
//      new cluster. A cluster is moved as a RIGID UNIT: every member keeps its
//      exact offset relative to the cluster top, so a cluster's internal layout
//      (including overlaps) is byte-for-byte preserved.
//   3. It re-stacks clusters top-to-bottom with the canonical gaps (48 around
//      heroes, 56 between sections), snaps the opening/closing hero heights to
//      the target, and re-fits each colour band around the clusters that
//      originally sat inside it (56px inner padding top & bottom).
//
// Guarantees: block copy/content/ids/types and their ARRAY ORDER are never
// touched. Only bp.desktop.{x,y,w,h}, hero/band heights, a small set of style
// paddings and divider thickness change. Deterministic and idempotent (a second
// pass produces no further changes). Returns { design, changes }.
// ---------------------------------------------------------------------------

// Vertical gap (px) beyond which two consecutive blocks belong to different
// clusters. Below this they are treated as one tightly-coupled unit and moved
// together. Chosen above the largest intra-cluster gap in the provisioning
// layout (icon→h3 = 12, divider→body = 20, card-row→card-row = 24) and below
// the smallest inter-section gap (48/56).
const CLUSTER_GAP_THRESHOLD = 40;
const BAND_INNER_PAD = 56; // colour-band inner padding, top & bottom

function deskOf(block) {
  return block && block.bp && block.bp.desktop ? block.bp.desktop : null;
}

function isFlowVisible(block) {
  const d = deskOf(block);
  return !!d && !d.hidden && (num(d.h) ?? 0) > 0;
}

export function normalizeDesignFull(design) {
  // Step 1: safe deterministic knobs + content-column x/w (shared with report).
  const { design: clone, changes } = normalizeDesign(design);
  const record = (blockId, field, from, to) => {
    if (from === to) return;
    changes.push({ blockId, field, from, to });
  };
  const sections = clone?.root?.sections || [];
  for (const section of sections) {
    reflowSectionVertical(section.children || [], record);
  }
  return { design: clone, changes };
}

function reflowSectionVertical(children, record) {
  const bands = children.filter((b) => b.type === 'section' && isFlowVisible(b));
  const bandIds = new Set(bands.map((b) => b.id));

  // Snapshot ORIGINAL geometry before any mutation (band re-fit maps off this).
  const orig = new Map();
  for (const b of children) {
    const d = deskOf(b);
    if (d) orig.set(b.id, { y: num(d.y) ?? 0, h: num(d.h) ?? 0 });
  }

  const flow = children
    .filter((b) => !bandIds.has(b.id) && isFlowVisible(b))
    .sort((a, b) => (orig.get(a.id).y - orig.get(b.id).y) || ((deskOf(a).x ?? 0) - (deskOf(b).x ?? 0)));
  if (!flow.length) return;

  // Opening / closing hero identification (for height snap).
  const heroes = flow.filter((b) => b.type === 'hero');
  const openingHeroId = heroes.length ? heroes[0].id : null;
  const closingHeroId = heroes.length > 1 ? heroes[heroes.length - 1].id : null;
  const effectiveH = (b) => {
    const oh = orig.get(b.id).h;
    if (b.id === openingHeroId) return TARGET.HERO_OPEN_H;
    if (b.id === closingHeroId) return TARGET.HERO_CLOSE_H;
    return oh;
  };

  // Group into clusters by vertical proximity (rigid units).
  const clusters = [];
  let cur = null;
  let curBottom = -Infinity;
  for (const b of flow) {
    const oy = orig.get(b.id).y;
    const ob = oy + effectiveH(b);
    if (!cur || oy - curBottom > CLUSTER_GAP_THRESHOLD) {
      cur = { top: oy, items: [] };
      clusters.push(cur);
      curBottom = ob;
    } else {
      curBottom = Math.max(curBottom, ob);
    }
    cur.items.push(b);
    cur.top = Math.min(cur.top, oy);
  }

  const clusterHasHero = (c) => c.items.some((b) => b.type === 'hero');

  // Re-stack clusters top-to-bottom with canonical gaps.
  const placed = new Map(); // blockId -> { newY, h }
  let cursor = 0;
  clusters.forEach((c, i) => {
    let top;
    if (i === 0) {
      top = 0;
    } else {
      const prev = clusters[i - 1];
      const gap = clusterHasHero(prev) || clusterHasHero(c)
        ? TARGET.GAP_AFTER_HERO
        : TARGET.SECTION_GAP;
      top = cursor + gap;
    }
    let clusterHeight = 0;
    let origBottom = -Infinity;
    for (const b of c.items) {
      const offset = orig.get(b.id).y - c.top;
      const h = effectiveH(b);
      const newY = top + offset;
      placed.set(b.id, { newY, h });
      clusterHeight = Math.max(clusterHeight, offset + h);
      origBottom = Math.max(origBottom, orig.get(b.id).y + h);
    }
    c.origTop = c.top;
    c.origBottom = origBottom;
    c.newTop = top;
    c.newBottom = top + clusterHeight;
    cursor = top + clusterHeight;
  });

  // Apply the reflow: mutate desktop.y and hero heights; record deltas.
  for (const b of flow) {
    const d = b.bp.desktop;
    const p = placed.get(b.id);
    if (!p) continue;
    if (num(d.y) !== p.newY) { record(b.id, 'desktop.y', num(d.y), p.newY); d.y = p.newY; }
    if ((b.id === openingHeroId || b.id === closingHeroId) && num(d.h) !== p.h) {
      record(b.id, 'desktop.h', num(d.h), p.h); d.h = p.h;
    }
  }

  // Re-fit each colour band around the CLUSTERS that originally sat inside it,
  // then wrap them with 56px inner padding. Assigning whole clusters (not
  // individual blocks) is what makes the re-fit idempotent: cluster membership
  // is stable across passes (intra-cluster gaps are preserved and inter-cluster
  // gaps become 48/56, so the same clusters re-form), and a cluster whose
  // vertical midpoint sits inside the band box on pass 1 still does on pass 2
  // (the refit box wraps it with equal padding on both sides). This also keeps
  // an overlapping neighbour that clustered WITH the band content travelling
  // with the band, instead of flip-flopping in and out of the set.
  for (const band of bands) {
    const bTop = orig.get(band.id).y;
    const bBottom = bTop + orig.get(band.id).h;
    const inside = clusters.filter((c) => {
      const mid = (c.origTop + c.origBottom) / 2;
      return mid > bTop && mid < bBottom;
    });
    if (!inside.length) continue;
    let minY = Infinity;
    let maxBottom = -Infinity;
    for (const c of inside) {
      minY = Math.min(minY, c.newTop);
      maxBottom = Math.max(maxBottom, c.newBottom);
    }
    const newTop = minY - BAND_INNER_PAD;
    const newH = (maxBottom + BAND_INNER_PAD) - newTop;
    const d = band.bp.desktop;
    if (num(d.y) !== newTop) { record(band.id, 'desktop.y', num(d.y), newTop); d.y = newTop; }
    if (num(d.h) !== newH) { record(band.id, 'desktop.h', num(d.h), newH); d.h = newH; }
  }
}

// ---------------------------------------------------------------------------
// Content-preservation verifier. Deep-compares two designs after stripping the
// fields the normalizer is allowed to change (desktop x/y/w/h, style paddings,
// divider thickness). Any other difference — block copy, content, ids, types,
// names, a11y, ordering, tablet/mobile geometry — is reported as a violation.
// Returns { ok, diffs }.
// ---------------------------------------------------------------------------
const VOLATILE_STYLE_KEYS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];

function stripVolatile(design) {
  const clone = JSON.parse(JSON.stringify(design ?? null));
  const sections = clone?.root?.sections || [];
  for (const s of sections) {
    for (const b of s.children || []) {
      if (b.bp && b.bp.desktop) {
        for (const k of ['x', 'y', 'w', 'h']) delete b.bp.desktop[k];
      }
      if (b.style) for (const k of VOLATILE_STYLE_KEYS) delete b.style[k];
      if (b.type === 'divider' && b.content && 'thickness' in b.content) delete b.content.thickness;
    }
  }
  return clone;
}

export function verifyContentPreserved(before, after) {
  const diffs = [];
  const secBefore = before?.root?.sections || [];
  const secAfter = after?.root?.sections || [];
  if (secBefore.length !== secAfter.length) {
    diffs.push(`section count changed: ${secBefore.length} -> ${secAfter.length}`);
  }
  const n = Math.min(secBefore.length, secAfter.length);
  for (let i = 0; i < n; i++) {
    const cb = secBefore[i].children || [];
    const ca = secAfter[i].children || [];
    if (cb.length !== ca.length) {
      diffs.push(`section[${i}] block count changed: ${cb.length} -> ${ca.length}`);
    }
    const m = Math.min(cb.length, ca.length);
    for (let j = 0; j < m; j++) {
      if (cb[j].id !== ca[j].id) {
        diffs.push(`section[${i}] block[${j}] id/order changed: ${cb[j].id} -> ${ca[j].id}`);
      }
      if (cb[j].type !== ca[j].type) {
        diffs.push(`block ${cb[j].id} type changed: ${cb[j].type} -> ${ca[j].type}`);
      }
    }
  }
  const sb = JSON.stringify(stripVolatile(before));
  const sa = JSON.stringify(stripVolatile(after));
  if (sb !== sa) {
    diffs.push('non-geometry content differs after stripping allowed geometry/padding fields');
  }
  return { ok: diffs.length === 0, diffs };
}

// ---------------------------------------------------------------------------
// CLEANUP — the "Clean up" multi-page action on /IEditPageManagement.
//
// A single, idempotent pass that (in order):
//   1. Removes sample/placeholder content — the dashed "note" text boxes the
//      layout engine emits for deferred interactive surfaces (searchable
//      directories, video embeds, etc.). These are the ONLY blocks treated as
//      sample content; the signal is deliberately specific (a text block with a
//      dashed border) so real content is never touched.
//   2. Equalizes card heights per visual row so a row of cards shares the row's
//      tallest height (only bp.desktop.h changes — a field the verifier strips).
//   3. Runs the cluster-preserving spacing/rhythm normalization
//      (normalizeDesignFull).
//
// The result is verified with verifyContentPreserved against the ORIGINAL design
// minus the intentionally-removed sample blocks, so any accidental content loss
// is caught. Deterministic and idempotent: a second pass over a cleaned design
// removes nothing, equalizes nothing, and reflows nothing.
//
// Returns { design, changes, removed, verify }.
// ---------------------------------------------------------------------------

// A sample/placeholder block: a text block rendered inside a dashed frame.
function isSamplePlaceholder(block) {
  return block?.type === 'text' && block?.style?.borderStyle === 'dashed';
}

// Deep-clone a design with the given block ids removed from every section.
function stripRemoved(design, removedIds) {
  const clone = JSON.parse(JSON.stringify(design ?? null));
  for (const s of clone?.root?.sections || []) {
    s.children = (s.children || []).filter((b) => !removedIds.has(b.id));
  }
  return clone;
}

// Equalize card heights within each visual row (cards whose desktop.y is within
// rowTol). Mutates children in place; records desktop.h changes.
function equalizeCardRows(children, changes, rowTol = 24) {
  const cards = (children || []).filter((b) => b.type === 'card' && deskOf(b) && isFlowVisible(b));
  if (cards.length < 2) return;
  const sorted = [...cards].sort((a, b) => (num(deskOf(a).y) ?? 0) - (num(deskOf(b).y) ?? 0));
  const rows = [];
  for (const c of sorted) {
    const y = num(deskOf(c).y) ?? 0;
    const last = rows[rows.length - 1];
    if (last && Math.abs(y - last.y) <= rowTol) last.items.push(c);
    else rows.push({ y, items: [c] });
  }
  for (const row of rows) {
    if (row.items.length < 2) continue;
    const maxH = Math.max(...row.items.map((c) => num(deskOf(c).h) ?? 0));
    if (!(maxH > 0)) continue;
    for (const c of row.items) {
      const d = deskOf(c);
      const cur = num(d.h) ?? 0;
      if (cur !== maxH) {
        changes.push({ blockId: c.id, field: 'desktop.h', from: cur, to: maxH });
        d.h = maxH;
      }
    }
  }
}

export function cleanupDesign(design, opts = {}) {
  const removeSample = opts.removeSample !== false;
  const equalizeCards = opts.equalizeCards !== false;

  const work = JSON.parse(JSON.stringify(design ?? null));
  const changes = [];
  const removed = [];

  // 1. Sample-content removal.
  if (removeSample) {
    for (const s of work?.root?.sections || []) {
      const kept = [];
      for (const b of s.children || []) {
        if (isSamplePlaceholder(b)) {
          removed.push({ id: b.id, type: b.type, name: b.name || '' });
          changes.push({ blockId: b.id, field: 'removed', from: 'sample-placeholder', to: null });
        } else {
          kept.push(b);
        }
      }
      s.children = kept;
    }
  }

  // 2. Card-height equalization (per row, per section).
  if (equalizeCards) {
    for (const s of work?.root?.sections || []) {
      equalizeCardRows(s.children || [], changes);
    }
  }

  // 3. Spacing / rhythm normalization (cluster-preserving reflow).
  const { design: normalized, changes: normChanges } = normalizeDesignFull(work);
  for (const c of normChanges) changes.push(c);

  // 4. Content-preservation verification against the original minus the blocks
  // we intentionally removed.
  const removedIds = new Set(removed.map((r) => r.id));
  const beforeMinus = stripRemoved(design, removedIds);
  const verify = verifyContentPreserved(beforeMinus, normalized);

  return { design: normalized, changes, removed, verify };
}
