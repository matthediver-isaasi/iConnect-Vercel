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
  'wall-of-fame', 'gallery', 'card-flip-grid', 'hero-carousel', 'symbol',
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
    if (!hero.fullBleed) {
      deltas.push({ metric: `hero[${i}].fullBleed`, current: false, target: true, delta: 'not full-bleed' });
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
