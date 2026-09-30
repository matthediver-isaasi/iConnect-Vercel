// ---------------------------------------------------------------------------
// Task #2434: Canvas Builder "Auto build" — generate tablet (768px) and
// mobile (375px) breakpoint layouts from the desktop layout.
//
// Pure, React-free module. The generator reads ONLY desktop geometry and
// writes explicit x/y/w/h overrides into each block's `bp.tablet` and
// `bp.mobile` layers — the desktop layer is never touched, so the desktop
// render stays pixel-identical. Existing tablet/mobile overrides are
// replaced wholesale (only a per-breakpoint `hidden` override is preserved,
// since visibility is an authorial choice rather than layout).
//
// Approach (mirrors the cluster-aware reflow used by the doc→canvas layout
// engine and scripts/lib/canvasSpacing.mjs — per-block reflow never reaches
// a fixed point, so all movement is computed per CLUSTER of vertically
// overlapping blocks):
//   1. Classify blocks: sections (colour bands) wrap content; overlay blocks
//      (fully contained inside another block, e.g. a logo on a hero) stay
//      anchored to their host; everything else participates in the flow.
//   2. Group flow blocks into clusters by transitive vertical overlap of
//      their desktop boxes; order clusters top-to-bottom and members in
//      column-grouped reading order (left column first, top-to-bottom).
//   3. Mobile: stack every member full-column-width. Tablet: clusters whose
//      side-by-side columns are narrow enough are re-fit two-across;
//      everything else stacks.
//   4. Sections are re-fitted around the new positions of their desktop
//      members, preserving (clamped) inner paddings, so bands grow/shrink
//      to contain the reflowed content.
//
// Height estimates: auto-height blocks (Text, Accordion, Card) get a
// width-ratio estimate — the editor's commitAutoHeight and the public
// runtime reflow (AccordionReflowContext) then correct the estimate against
// the real rendered height, exactly as they do for manual edits. Media
// blocks (image/video/map/gallery) scale proportionally to preserve aspect.
// ---------------------------------------------------------------------------

import {
  BLOCK_TYPES,
  BREAKPOINT_WIDTHS,
  blockIsFullWidthLike,
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
} from './canvasDesign';

const DESKTOP_W = BREAKPOINT_WIDTHS.desktop;

// Per-target layout rhythm. Gap buckets keep the desktop's spacing
// hierarchy (tight caption gaps stay tight, section gaps stay generous)
// while normalising everything onto a consistent scale.
const TARGETS = {
  tablet: {
    width: BREAKPOINT_WIDTHS.tablet,
    margin: 24,
    colGap: 24,
    innerGap: 24,
    gapSmall: 12,
    gapMedium: 24,
    gapLarge: 48,
    bandPadMax: 40,
    pairing: true,
    stretchMinW: 600,
  },
  mobile: {
    width: BREAKPOINT_WIDTHS.mobile,
    margin: 16,
    colGap: 16,
    innerGap: 20,
    gapSmall: 12,
    gapMedium: 24,
    gapLarge: 40,
    bandPadMax: 32,
    pairing: false,
    // On mobile almost everything reads better full-column; only genuinely
    // small blocks (buttons, icons, badges) keep their natural width.
    stretchMinW: 275,
  },
};

// Desktop columns narrower than this may sit two-across on tablet.
const TABLET_PAIR_MAX_COL_W = 620;
// Blocks whose desktop centre is within this many px of the stage centre
// are considered centre-aligned.
const CENTER_TOL = 40;
// Blocks whose right edge is within this many px of the desktop content
// right edge are considered right-aligned (desktop content margin ~150px).
const RIGHT_EDGE_TOL = 170;

// Media blocks that must keep their aspect ratio when resized.
const PROPORTIONAL_TYPES = new Set([
  BLOCK_TYPES.IMAGE,
  BLOCK_TYPES.VIDEO,
  BLOCK_TYPES.MAP,
  BLOCK_TYPES.GALLERY,
]);

function desktopGeom(block) {
  return resolveBlockAtBreakpoint(block, 'desktop', { canvasWidth: DESKTOP_W });
}

// Resolved `hidden` at a target breakpoint using the stored layers
// (mobile -> tablet -> desktop cascade), so blocks the author already
// hid on tablet/mobile stay out of the generated flow.
function hiddenAt(block, target) {
  const d = block.bp?.desktop || {};
  const t = block.bp?.tablet || {};
  const m = block.bp?.mobile || {};
  const pick = (layer) =>
    layer.hidden !== undefined && layer.hidden !== null ? layer.hidden : undefined;
  if (target === 'mobile') {
    return pick(m) ?? pick(t) ?? pick(d) ?? false;
  }
  return pick(t) ?? pick(d) ?? false;
}

function rectContains(host, inner, tol = 4) {
  return (
    inner.x >= host.x - tol &&
    inner.y >= host.y - tol &&
    inner.x + inner.w <= host.x + host.w + tol &&
    inner.y + inner.h <= host.y + host.h + tol
  );
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Estimate a block's height when rendered at `newW` on `target`.
function estimateHeight(item, newW, target) {
  const { b, d, def } = item;
  const oldW = Math.max(1, d.w || 1);
  const h = Math.max(1, d.h || 1);
  if (def?.noResize) return h;
  if (b.type === BLOCK_TYPES.COLUMNS) {
    // The Columns block stacks its internal columns natively on mobile
    // (stackOnMobile), so the box needs room for n stacked columns.
    if (target === 'mobile' && b.content?.stackOnMobile !== false) {
      const n = Array.isArray(b.content?.items)
        ? Math.max(1, b.content.items.length)
        : 2;
      return Math.round(h * n);
    }
    return h;
  }
  if (PROPORTIONAL_TYPES.has(b.type)) {
    return Math.max(24, Math.round((h * newW) / oldW));
  }
  if (def?.autoHeight) {
    // Text-like content wraps taller as it narrows. Linear area-preserving
    // estimate, capped so a hero-wide paragraph can't explode; the runtime
    // auto-height reflow corrects the estimate against the real render.
    const factor = clamp(oldW / newW, 0.5, 3);
    return Math.max(24, Math.round(h * factor));
  }
  return h;
}

// Compute { w, h, x } for a flow block at the target breakpoint.
// forcedW/colX are set when the block is placed in a tablet column pair.
function computeBox(item, cfg, target, forcedW = null, colX = null) {
  const { b, d, def } = item;
  const W = cfg.width;
  const contentW = W - cfg.margin * 2;

  if (blockIsFullWidthLike(b)) {
    // x/w derive from the canvas at resolve time; only y (and h) are stored.
    return { fullWidth: true, w: W, h: estimateHeight(item, W, target), x: 0 };
  }

  if (b.type === BLOCK_TYPES.SYMBOL) {
    // A symbol box derives w/h from its resolved content at render time —
    // the stored w/h are placeholders, so no width heuristics apply. Its
    // content can span the full stage (e.g. a mega-menu authored to be
    // stage-wide per breakpoint), so scale the host x proportionally
    // (desktop x=0 stays 0, centred hosts stay centred) and, when the
    // editor supplies the resolved content extent, clamp the host so the
    // content stays on the stage.
    const ext = cfg.getSymbolExtent
      ? cfg.getSymbolExtent(b.content?.symbolId, target)
      : null;
    const w = Number.isFinite(ext?.w) ? Math.min(ext.w, W) : Math.min(d.w, W);
    const h = Number.isFinite(ext?.h) ? ext.h : d.h;
    const x = Math.round(
      clamp((d.x * W) / DESKTOP_W, 0, Math.max(0, W - w)),
    );
    return { fullWidth: false, symbol: true, w, h, x };
  }

  let w;
  if (def?.noResize) {
    w = Math.min(d.w, contentW);
  } else if (forcedW != null) {
    w = d.w >= 300 ? forcedW : Math.min(d.w, forcedW);
  } else if (d.w >= cfg.stretchMinW || d.w > contentW) {
    w = contentW;
  } else {
    w = d.w;
  }
  w = Math.round(w);

  const h = estimateHeight(item, w, target);

  let x;
  if (forcedW != null) {
    x = colX;
  } else if (w >= contentW) {
    x = cfg.margin;
  } else {
    // Preserve the desktop alignment intent for narrow blocks.
    const center = d.x + d.w / 2;
    if (Math.abs(center - DESKTOP_W / 2) <= CENTER_TOL) {
      x = Math.round((W - w) / 2);
    } else if (
      DESKTOP_W - (d.x + d.w) <= RIGHT_EDGE_TOL &&
      d.x > RIGHT_EDGE_TOL
    ) {
      x = W - cfg.margin - w;
    } else {
      x = cfg.margin;
    }
  }
  return { fullWidth: false, w, h, x: Math.round(x) };
}

// Group cluster members into left-to-right columns by x-overlap.
function columnsOf(members) {
  const sorted = [...members].sort((a, b) => a.d.x - b.d.x || a.d.y - b.d.y);
  const cols = [];
  for (const m of sorted) {
    const col = cols.find(
      (c) => m.d.x < c.right - 8 && m.d.x + m.d.w > c.left + 8,
    );
    if (col) {
      col.items.push(m);
      col.left = Math.min(col.left, m.d.x);
      col.right = Math.max(col.right, m.d.x + m.d.w);
    } else {
      cols.push({ left: m.d.x, right: m.d.x + m.d.w, items: [m] });
    }
  }
  cols.sort((a, b) => a.left - b.left);
  for (const c of cols) c.items.sort((a, b) => a.d.y - b.d.y || a.d.x - b.d.x);
  return cols;
}

// Build the geometry patch to store for one block.
function patchFor(item, box, y) {
  const { b } = item;
  if (b.type === BLOCK_TYPES.SYMBOL) {
    // Symbol boxes derive w/h from resolved content at read time — only the
    // host position is ever stored (mirrors applyGeometry).
    return { x: box.x, y: Math.round(y) };
  }
  if (box.fullWidth) {
    return { y: Math.round(y), h: Math.round(box.h) };
  }
  return {
    x: Math.round(box.x),
    y: Math.round(y),
    w: Math.round(box.w),
    h: Math.round(box.h),
  };
}

// Bucket a desktop inter-cluster gap onto the target's rhythm scale.
function bucketGap(desktopGap, cfg) {
  if (desktopGap <= 16) return cfg.gapSmall;
  if (desktopGap <= 40) return cfg.gapMedium;
  return cfg.gapLarge;
}

// Plan one target breakpoint. Returns Map(blockId -> geometry patch).
function planTarget(children, target, getDef, getSymbolExtent) {
  const cfg = { ...TARGETS[target], getSymbolExtent };
  const contentW = cfg.width - cfg.margin * 2;
  const patches = new Map();

  const items = children
    .filter((b) => b && typeof b === 'object' && b.id)
    .map((b) => {
      const d = desktopGeom(b);
      // A symbol's stored w/h are placeholders — the real footprint comes
      // from its resolved content. Substitute the desktop extent (when
      // known) so overlay detection and clustering see the true box.
      if (b.type === BLOCK_TYPES.SYMBOL && getSymbolExtent) {
        const ext = getSymbolExtent(b.content?.symbolId, 'desktop');
        if (ext && Number.isFinite(ext.w) && Number.isFinite(ext.h)) {
          return { b, d: { ...d, w: ext.w, h: ext.h }, def: getDef ? getDef(b.type) : null };
        }
      }
      return { b, d, def: getDef ? getDef(b.type) : null };
    });

  // Hidden blocks stay hidden and keep no generated geometry.
  const visible = items.filter((it) => !it.d.hidden && !hiddenAt(it.b, target));

  const sections = visible.filter((it) => it.b.type === BLOCK_TYPES.SECTION);
  const nonSection = visible.filter((it) => it.b.type !== BLOCK_TYPES.SECTION);

  // Overlay detection: a block fully contained inside a (larger) non-section
  // block stays anchored to that host instead of flowing (logo on a hero,
  // badge on an image, ...). One level only — a host must itself flow.
  const overlayHost = new Map(); // item -> host item
  for (const it of nonSection) {
    let best = null;
    for (const host of nonSection) {
      if (host === it) continue;
      const hostArea = host.d.w * host.d.h;
      const itArea = it.d.w * it.d.h;
      if (hostArea <= itArea) continue;
      if (!rectContains(host.d, it.d)) continue;
      if (!best || hostArea < best.d.w * best.d.h) best = host;
    }
    if (best) overlayHost.set(it, best);
  }
  // Hosts that were themselves marked as overlays go back into the flow.
  for (const [it, host] of [...overlayHost.entries()]) {
    if (overlayHost.has(host)) overlayHost.delete(it);
  }
  const overlays = [...overlayHost.keys()];
  const flow = nonSection.filter((it) => !overlayHost.has(it));

  // Sections with no flow members are ordinary flow blocks (empty bands).
  const sectionRecords = [];
  const memberToSection = new Map();
  for (const s of sections) {
    const members = flow.filter(
      (m) =>
        m.d.y >= s.d.y - 2 && m.d.y + m.d.h <= s.d.y + s.d.h + 2,
    );
    if (members.length === 0) {
      flow.push(s);
      continue;
    }
    const firstY = Math.min(...members.map((m) => m.d.y));
    const lastBottom = Math.max(...members.map((m) => m.d.y + m.d.h));
    const rec = {
      s,
      members,
      padTop: clamp(Math.round(firstY - s.d.y), 12, cfg.bandPadMax),
      padBottom: clamp(Math.round(s.d.y + s.d.h - lastBottom), 12, cfg.bandPadMax),
      firstMember: null,
      lastMember: null,
    };
    for (const m of members) {
      if (!rec.firstMember || m.d.y < rec.firstMember.d.y) rec.firstMember = m;
      if (
        !rec.lastMember ||
        m.d.y + m.d.h > rec.lastMember.d.y + rec.lastMember.d.h
      ) {
        rec.lastMember = m;
      }
      memberToSection.set(m, rec);
    }
    sectionRecords.push(rec);
  }

  if (flow.length === 0) return patches;

  // Cluster flow blocks by transitive vertical overlap.
  const ordered = [...flow].sort((a, b) => a.d.y - b.d.y || a.d.x - b.d.x);
  const clusters = [];
  let cur = null;
  for (const it of ordered) {
    if (cur && it.d.y < cur.bottom - 4) {
      cur.items.push(it);
      cur.bottom = Math.max(cur.bottom, it.d.y + it.d.h);
    } else {
      cur = { top: it.d.y, bottom: it.d.y + it.d.h, items: [it] };
      clusters.push(cur);
    }
  }

  const placed = new Map(); // item -> { x, y, w, h, fullWidth }

  const place = (item, box, y) => {
    placed.set(item, { ...box, y: Math.round(y) });
    patches.set(item.b.id, patchFor(item, box, y));
  };

  // Stack one column of items full-width from `startY`; returns bottom.
  const stackFull = (colItems, startY) => {
    let yCursor = startY;
    for (const m of colItems) {
      const box = computeBox(m, cfg, target);
      place(m, box, yCursor);
      yCursor += box.h + cfg.innerGap;
    }
    return yCursor - cfg.innerGap;
  };

  let currentY = clamp(clusters[0].top, 0, 40);
  let prevCluster = null;

  for (const cluster of clusters) {
    // Rhythm gap from the previous cluster, bucketed off the desktop gap.
    if (prevCluster) {
      const desktopGap = cluster.top - prevCluster.bottom;
      currentY += bucketGap(desktopGap, cfg);
    }
    // Reserve band top padding for sections starting at this cluster.
    for (const rec of sectionRecords) {
      if (cluster.items.includes(rec.firstMember)) currentY += rec.padTop;
    }

    const cols = columnsOf(cluster.items);
    const canPair =
      cfg.pairing &&
      cols.length >= 2 &&
      cols.every(
        (c) =>
          c.items.every(
            (m) => m.d.w <= TABLET_PAIR_MAX_COL_W && !blockIsFullWidthLike(m.b),
          ),
      );

    let clusterBottom = currentY;
    if (canPair) {
      // Two columns across; chunk 3+ columns into rows of two.
      const colW = Math.round((contentW - cfg.colGap) / 2);
      let rowTop = currentY;
      for (let i = 0; i < cols.length; i += 2) {
        const pair = cols.slice(i, i + 2);
        if (pair.length === 1) {
          clusterBottom = stackFull(pair[0].items, rowTop);
          rowTop = clusterBottom + cfg.innerGap;
          continue;
        }
        let rowBottom = rowTop;
        pair.forEach((col, ci) => {
          const colX = cfg.margin + ci * (colW + cfg.colGap);
          let yCursor = rowTop;
          for (const m of col.items) {
            const box = computeBox(m, cfg, target, colW, colX);
            // Centre narrower-than-column blocks within their column.
            if (box.w < colW) box.x = Math.round(colX + (colW - box.w) / 2);
            place(m, box, yCursor);
            yCursor += box.h + cfg.innerGap;
          }
          rowBottom = Math.max(rowBottom, yCursor - cfg.innerGap);
        });
        clusterBottom = rowBottom;
        rowTop = rowBottom + cfg.innerGap;
      }
    } else {
      // Single-column stack in column-grouped reading order.
      const readingOrder = cols.flatMap((c) => c.items);
      clusterBottom = stackFull(readingOrder, currentY);
    }

    currentY = clusterBottom;
    // Band bottom padding for sections ending at this cluster.
    for (const rec of sectionRecords) {
      if (cluster.items.includes(rec.lastMember)) currentY += rec.padBottom;
    }
    prevCluster = cluster;
  }

  // Overlays: keep them anchored inside their (now re-fitted) host.
  for (const it of overlays) {
    const host = overlayHost.get(it);
    const hp = placed.get(host);
    if (!hp) continue; // host hidden/unplaced — leave the overlay inheriting desktop
    const scaleX = hp.w / Math.max(1, host.d.w);
    const scaleY = hp.h / Math.max(1, host.d.h);
    let w = Math.round(Math.min(it.d.w, hp.w));
    let h = it.d.h;
    if (PROPORTIONAL_TYPES.has(it.b.type) && w !== it.d.w) {
      h = Math.max(1, Math.round((it.d.h * w) / Math.max(1, it.d.w)));
    }
    const hostX = hp.fullWidth ? 0 : hp.x;
    let x = Math.round(hostX + (it.d.x - host.d.x) * scaleX);
    let y = Math.round(hp.y + (it.d.y - host.d.y) * scaleY);
    x = clamp(x, hostX, Math.max(hostX, hostX + hp.w - w));
    y = clamp(y, hp.y, Math.max(hp.y, hp.y + hp.h - h));
    if (it.b.type === BLOCK_TYPES.SYMBOL) {
      patches.set(it.b.id, { x, y });
    } else if (blockIsFullWidthLike(it.b)) {
      patches.set(it.b.id, { y, h: Math.round(h) });
    } else {
      patches.set(it.b.id, { x, y, w, h: Math.round(h) });
    }
    placed.set(it, { x, y, w, h, fullWidth: false });
  }

  // Re-fit sections around the new member positions.
  for (const rec of sectionRecords) {
    const tops = rec.members
      .map((m) => placed.get(m))
      .filter(Boolean);
    if (tops.length === 0) continue;
    const minTop = Math.min(...tops.map((p) => p.y));
    const maxBottom = Math.max(...tops.map((p) => p.y + p.h));
    const y = Math.round(minTop - rec.padTop);
    const h = Math.round(maxBottom + rec.padBottom - y);
    if (blockIsFullWidthLike(rec.s.b)) {
      patches.set(rec.s.b.id, { y, h });
    } else {
      // Non-full-bleed band: scale horizontally in proportion to the stage.
      const scale = cfg.width / DESKTOP_W;
      patches.set(rec.s.b.id, {
        x: Math.round(rec.s.d.x * scale),
        y,
        w: Math.round(rec.s.d.w * scale),
        h,
      });
    }
  }

  return patches;
}

// Rebuild a block's tablet/mobile layer: preserve only an explicit
// `hidden` override, then apply the generated geometry (if any).
function rebuildLayer(block, bpName, patch) {
  const prev = block.bp?.[bpName] || {};
  const layer = {};
  if (prev.hidden !== undefined && prev.hidden !== null) layer.hidden = prev.hidden;
  if (patch) Object.assign(layer, patch);
  return layer;
}

/**
 * Generate tablet + mobile layouts from the desktop layout. Returns a new
 * design document with every root block's `bp.tablet` / `bp.mobile` layers
 * replaced (desktop untouched). `getBlockDefinition` comes from the editor's
 * block registry and supplies per-type flags (autoHeight, noResize, ...).
 * `getSymbolExtent(symbolId, breakpoint)` optionally resolves a symbol's
 * rendered content extent so symbol hosts can be kept on the stage.
 */
export function generateAutoLayout(design, { getBlockDefinition, getSymbolExtent } = {}) {
  const d = normalizeCanvasDesign(design);
  return {
    ...d,
    root: {
      ...d.root,
      sections: d.root.sections.map((section) => {
        const children = Array.isArray(section.children) ? section.children : [];
        const tabletPlan = planTarget(children, 'tablet', getBlockDefinition, getSymbolExtent);
        const mobilePlan = planTarget(children, 'mobile', getBlockDefinition, getSymbolExtent);
        return {
          ...section,
          children: children.map((b) => ({
            ...b,
            bp: {
              ...b.bp,
              tablet: rebuildLayer(b, 'tablet', tabletPlan.get(b.id)),
              mobile: rebuildLayer(b, 'mobile', mobilePlan.get(b.id)),
            },
          })),
        };
      }),
    },
  };
}

const GEOMETRY_KEYS = ['x', 'y', 'w', 'h', 'manualHeight'];

/**
 * True when any block already carries tablet/mobile geometry overrides —
 * used to warn before Auto build replaces them.
 */
export function hasResponsiveGeometryOverrides(design) {
  const d = normalizeCanvasDesign(design);
  for (const section of d.root.sections) {
    for (const b of section.children || []) {
      for (const bpName of ['tablet', 'mobile']) {
        const layer = b.bp?.[bpName];
        if (!layer) continue;
        if (GEOMETRY_KEYS.some((k) => layer[k] !== undefined && layer[k] !== null)) {
          return true;
        }
      }
    }
  }
  return false;
}
