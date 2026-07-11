// Pure decision logic for baking an auto-height block's measured height into
// stored canvas geometry (see CanvasBuilder.jsx `commitAutoHeight`). Extracted
// so the corruption guard added for the "transient short measurement collapses
// the page and autosaves over the good version" bug is covered by DOM-free
// unit tests. Nothing here touches React, the DOM, or the block registry — the
// block definition is passed in via `getDefinition` so the module stays pure.
//
// See .agents/memory/canvas-autoheight-commit.md for the full rationale.
import {
  BLOCK_TYPES,
  resolveBlockAtBreakpoint,
  setBlockBp,
  getRootChildren,
  setRootChildren,
} from '../../lib/canvasDesign.js';

// Auto-height commit tuning (single source of truth; CanvasBuilder imports
// these so the runtime debounce and the tests stay in lockstep).
//   AUTOHEIGHT_DEBOUNCE_MS — settle window for a normal (grow / small change)
//     measurement before it bakes.
//   SHRINK_DEBOUNCE_MS — a longer settle window for a SUSPECT SHRINK (a block
//     measuring much shorter than its stored height): a transient too-small
//     measurement must stay the last reported height for this whole window
//     (otherwise the ResizeObserver would have reset the timer) before it may
//     bake, so a late image/font/breakpoint measurement can never collapse it.
//   SHRINK_SUSPECT_PX — how much shorter than stored a measurement must be to
//     be treated as a suspect shrink.
//   AUTOHEIGHT_DEAD_BAND_PX — ignore deltas smaller than this so the
//     ResizeObserver can't churn autosave with sub-pixel micro-changes.
export const AUTOHEIGHT_DEBOUNCE_MS = 200;
export const SHRINK_DEBOUNCE_MS = 700;
export const SHRINK_SUSPECT_PX = 12;
export const AUTOHEIGHT_DEAD_BAND_PX = 2;

// Stored (breakpoint-resolved) height of a block, or NaN if missing/hidden.
export function readStoredHeightAtBp(design, id, breakpoint) {
  try {
    const kids = getRootChildren(design);
    const target = kids.find((x) => x.id === id);
    if (!target) return NaN;
    const g = resolveBlockAtBreakpoint(target, breakpoint);
    return (g && !g.hidden) ? (g.h || 0) : NaN;
  } catch {
    return NaN;
  }
}

// Stored (breakpoint-resolved) width of a block, or NaN if missing/hidden.
// The auto-SIZE bake (Button / CTA) tracks width as well as height, so the
// suspect-shrink guard needs the stored width the same way it needs height.
export function readStoredWidthAtBp(design, id, breakpoint) {
  try {
    const kids = getRootChildren(design);
    const target = kids.find((x) => x.id === id);
    if (!target) return NaN;
    const g = resolveBlockAtBreakpoint(target, breakpoint);
    return (g && !g.hidden) ? (g.w || 0) : NaN;
  } catch {
    return NaN;
  }
}

// A measurement is a "suspect shrink" when it comes in at least
// `thresholdPx` shorter than the block's stored (previously-good) height. This
// is the corrupting case — baked as a negative delta it shrinks the block and
// pulls every block below it upward, collapsing the page — so it gets the long
// settle window while grows / small changes keep the fast path.
export function isSuspectShrink(storedHeight, measuredRounded, thresholdPx = SHRINK_SUSPECT_PX) {
  return (
    Number.isFinite(storedHeight) &&
    Number.isFinite(measuredRounded) &&
    (storedHeight - measuredRounded) >= thresholdPx
  );
}

// Debounce window to use for a given measurement: a suspect shrink waits the
// long window so a transient short measurement is corrected (its debounce
// reset) by the real height before it can ever bake.
export function autoHeightDebounceDelay(design, blockId, breakpoint, measuredRounded, {
  suspectPx = SHRINK_SUSPECT_PX,
  shrinkMs = SHRINK_DEBOUNCE_MS,
  normalMs = AUTOHEIGHT_DEBOUNCE_MS,
} = {}) {
  const stored = readStoredHeightAtBp(design, blockId, breakpoint);
  return isSuspectShrink(stored, measuredRounded, suspectPx) ? shrinkMs : normalMs;
}

// Debounce window for an auto-SIZE (Button / CTA) measurement: a suspect shrink
// in EITHER width or height gets the long window so a transient too-small
// measurement (font swap, icon/image decode, breakpoint switch) is corrected by
// the real size before it can ever bake.
export function autoSizeDebounceDelay(design, blockId, breakpoint, { width, height } = {}, {
  suspectPx = SHRINK_SUSPECT_PX,
  shrinkMs = SHRINK_DEBOUNCE_MS,
  normalMs = AUTOHEIGHT_DEBOUNCE_MS,
} = {}) {
  const storedH = readStoredHeightAtBp(design, blockId, breakpoint);
  const storedW = readStoredWidthAtBp(design, blockId, breakpoint);
  const suspect =
    isSuspectShrink(storedH, Math.round(height), suspectPx) ||
    isSuspectShrink(storedW, Math.round(width), suspectPx);
  return suspect ? shrinkMs : normalMs;
}

// Pure bake planner for AUTO-SIZE blocks (Button / CTA — `def.autoSize`). Unlike
// planAutoHeightBake (Text / Accordion), this commits BOTH the measured rendered
// width and height into the block's stored per-breakpoint geometry so the editor
// selection box and resize handles wrap the real button.
//
// Width and height are each independently dead-banded:
//   - a WIDTH change only resizes the block itself. A wider/narrower button does
//     NOT move blocks below it (Task #2662 keeps downstream push scoped to
//     height only — a label change primarily changes width).
//   - a HEIGHT change reuses the exact auto-height reflow: push every block
//     entirely below the target down by the height delta, and grow any Section /
//     Box that geometrically contains it by the same delta.
//
// Returns the next design, or `null` when nothing should change (block
// gone/hidden, not an autoSize block, or both deltas inside the dead-band).
export function planAutoSizeBake({
  design,
  blockId,
  breakpoint,
  measuredWidth,
  measuredHeight,
  getDefinition,
  deadBandPx = AUTOHEIGHT_DEAD_BAND_PX,
}) {
  if (!blockId) return null;

  const kids = getRootChildren(design);
  const target = kids.find((x) => x.id === blockId);
  if (!target) return null;

  const def = typeof getDefinition === 'function' ? getDefinition(target.type) : null;
  // Only autoSize blocks (Button / CTA) bake width. Plain auto-height blocks go
  // through planAutoHeightBake; cards use runtime row-height equalization.
  if (!def?.autoSize) return null;

  const tg = resolveBlockAtBreakpoint(target, breakpoint);
  if (!tg || tg.hidden) return null;

  const roundedW = Number.isFinite(measuredWidth) ? Math.round(measuredWidth) : NaN;
  const roundedH = Number.isFinite(measuredHeight) ? Math.round(measuredHeight) : NaN;
  let wChange =
    Number.isFinite(roundedW) && roundedW > 0 &&
    Math.abs(roundedW - (tg.w || 0)) >= deadBandPx;
  const hChange =
    Number.isFinite(roundedH) && roundedH > 0 &&
    Math.abs(roundedH - (tg.h || 0)) >= deadBandPx;

  // Task #2675: a manually-dragged width wins over a text-driven shrink. The
  // content-span measurement always reports the natural label width, so after
  // the user widens the button by hand we must not snap it back. A genuine
  // GROW past the manual width (a longer label) still bakes and clears the
  // flag so the button resumes auto-tracking its label.
  let clearManualWidth = false;
  if (wChange && tg.manualWidth) {
    if (roundedW > (tg.w || 0)) {
      clearManualWidth = true;
    } else {
      wChange = false;
    }
  }

  if (!wChange && !hChange) return null;

  const heightDelta = hChange ? roundedH - (tg.h || 0) : 0;
  const targetTop = tg.y;
  const targetBottom = tg.y + (tg.h || 0);

  const patch = {};
  if (wChange) {
    patch.w = roundedW;
    // A grow past the manual width resets the override so the block resumes
    // auto-tracking its label width (Task #2675).
    if (clearManualWidth) patch.manualWidth = false;
  }
  if (hChange) patch.h = roundedH;

  const nextKids = kids.map((x) => {
    if (x.id === blockId) return setBlockBp(x, breakpoint, patch);
    // Width-only changes never move neighbours (Task #2662 out-of-scope note).
    if (heightDelta === 0) return x;
    const g = resolveBlockAtBreakpoint(x, breakpoint);
    if (!g || g.hidden) return x;
    const gBottom = g.y + (g.h || 0);
    // Block entirely below the target -> shift down by the height delta.
    if (targetBottom <= g.y) {
      return setBlockBp(x, breakpoint, { y: Math.round(g.y + heightDelta) });
    }
    // Container (section or box) that contains the target -> grow by the delta.
    if (
      (x.type === BLOCK_TYPES.SECTION || x.type === BLOCK_TYPES.BOX) &&
      targetTop >= g.y &&
      targetBottom <= gBottom
    ) {
      return setBlockBp(x, breakpoint, { h: Math.round((g.h || 0) + heightDelta) });
    }
    return x;
  });

  return setRootChildren(design, nextKids);
}

// Re-anchor box-height formula — the SINGLE SOURCE OF TRUTH shared by the public
// renderer (AccordionReflowContext.getContainerGrowth) and the editor bake
// (planAutoHeightBake) so a V1 Box renders at the same height on both surfaces
// (Task #2680). A Box is a decorative background that wraps its contained
// auto-height content: it re-anchors its bottom beneath the DEEPEST contained
// MEASURED bottom while preserving the authored bottom inset (the gap the author
// left below the deepest STORED content). Because the height is driven by the
// deepest contained bottom — not a per-block incremental delta — a box that
// contains several auto-height blocks, that was manually resized, or whose
// content shrinks, settles to the SAME height on both surfaces.
//
//   containerTop / containerHeight — the box's stored (authored) geometry.
//   rows — the contained auto-height rows, each { storedBottom, measuredBottom }
//          in the SAME coordinate space as the box. Cards (autoHeight+cardGrow)
//          and absoluteFill blocks are excluded by the caller.
//
// Returns the box's correct height. With no contained rows the authored height
// is returned unchanged. The authored bottom inset is clamped non-negative so
// the box always fully contains its content.
export function computeReanchoredBoxHeight({ containerTop, containerHeight, rows }) {
  const height = Number.isFinite(containerHeight) ? containerHeight : 0;
  const containerBottom = containerTop + height;
  let deepestMeasuredBottom = null;
  let deepestStoredBottom = containerTop;
  for (const r of rows || []) {
    if (
      Number.isFinite(r?.measuredBottom) &&
      (deepestMeasuredBottom === null || r.measuredBottom > deepestMeasuredBottom)
    ) {
      deepestMeasuredBottom = r.measuredBottom;
    }
    if (Number.isFinite(r?.storedBottom) && r.storedBottom > deepestStoredBottom) {
      deepestStoredBottom = r.storedBottom;
    }
  }
  if (deepestMeasuredBottom === null) return height; // no contained content
  const authoredBottomInset = Math.max(0, containerBottom - deepestStoredBottom);
  return (deepestMeasuredBottom - containerTop) + authoredBottomInset;
}

// Public-renderer box growth (delta px added to the stored height). GROW-ONLY:
// a Box grows to wrap content that renders TALLER than its authored (stored)
// height and returns to that authored height when the content shrinks back, but
// it NEVER renders shorter than the author drew. The authored (stored) height is
// exactly what the builder shows for a Box (editorMode keeps containers at their
// stored geometry), so flooring the front-end at the stored height keeps the two
// surfaces identical for the common case where contained text renders shorter
// than its stored geometry — the drift that made a published 300px box collapse
// to its (shorter) text content while the builder still showed 300px.
//
// The re-anchor formula itself can legitimately return LESS than the stored
// height (that is how the editor bake reverses a prior grow), so the grow-only
// floor lives here in the public path, not inside computeReanchoredBoxHeight.
export function computeBoxGrowthDelta({ containerTop, containerHeight, rows }) {
  const base = Number.isFinite(containerHeight) ? containerHeight : 0;
  const resizedH = computeReanchoredBoxHeight({ containerTop, containerHeight, rows });
  return Math.max(0, resizedH - base);
}

// Compute a Box's re-anchored stored height from a design's contained
// auto-height (non-card) blocks. Pre-bake stored heights are the "stored"
// reference (they carry the authored bottom inset); the target block's newly
// measured height is substituted as its "measured" bottom. This mirrors the
// public getContainerGrowth exactly, where "stored" is the saved design and
// "measured" is the live DOM — so a baked box equals the front-end-grown box.
function boxReanchorHeight({ kids, box, boxGeom, breakpoint, getDefinition, targetId, targetMeasuredH }) {
  const boxBottom = boxGeom.y + (boxGeom.h || 0);
  const rows = [];
  for (const k of kids) {
    if (k.id === box.id) continue;
    const def = typeof getDefinition === 'function' ? getDefinition(k.type) : null;
    // Only plain auto-height blocks (Text / Accordion) drive box growth. Cards
    // (autoHeight + cardGrow) and non-auto-height blocks are excluded, mirroring
    // the public getContainerGrowth row set and keeping the exclusions intact.
    if (!def?.autoHeight || def?.cardGrow) continue;
    const g = resolveBlockAtBreakpoint(k, breakpoint);
    if (!g || g.hidden) continue;
    const storedBottom = g.y + (g.h || 0);
    // Contained when the block's stored span fits inside the box.
    if (g.y >= boxGeom.y && storedBottom <= boxBottom) {
      const measuredH = (k.id === targetId && Number.isFinite(targetMeasuredH))
        ? targetMeasuredH
        : (g.h || 0);
      rows.push({ storedBottom, measuredBottom: g.y + measuredH });
    }
  }
  return computeReanchoredBoxHeight({
    containerTop: boxGeom.y,
    containerHeight: boxGeom.h,
    rows,
  });
}

// Pure bake planner. Given a design and a settled measurement, returns the next
// design with the reflow baked in, or `null` if nothing should change (block
// gone/hidden, card block, or delta inside the dead-band). Mirrors
// AccordionReflowContext exactly so there is zero visual change:
//   1. set the target's own h to the measured height,
//   2. push every block entirely below it down by the delta,
//   3. grow every SECTION that geometrically contains it by the delta, and
//   4. re-anchor every BOX that contains it to the deepest contained content via
//      the shared computeReanchoredBoxHeight formula (Task #2680) — NOT a
//      per-block delta — so the baked box equals the front-end-grown box.
//
// `getDefinition(type)` supplies the block registry entry (needs `autoHeight`
// and `cardGrow`); passed in so this module never imports the React registry.
export function planAutoHeightBake({
  design,
  blockId,
  breakpoint,
  measuredHeight,
  getDefinition,
  deadBandPx = AUTOHEIGHT_DEAD_BAND_PX,
}) {
  if (!blockId || !Number.isFinite(measuredHeight)) return null;
  const rounded = Math.round(measuredHeight);
  if (rounded <= 0) return null;

  const kids = getRootChildren(design);
  const target = kids.find((x) => x.id === blockId);
  if (!target) return null;

  const def = typeof getDefinition === 'function' ? getDefinition(target.type) : null;
  // Bake heights only for plain auto-height blocks (Text, FAQ/Accordion). Card
  // blocks are autoHeight + cardGrow: their stored/manual box height is the
  // author's intended size and they rely on runtime row-height equalization, so
  // baking their measured content height would fight that system.
  if (!def?.autoHeight || def?.cardGrow) return null;

  const tg = resolveBlockAtBreakpoint(target, breakpoint);
  if (!tg || tg.hidden) return null;

  const delta = rounded - (tg.h || 0);
  // Dead-band: ignore tiny deltas so we don't fight the ResizeObserver or churn
  // autosave with micro-changes.
  if (Math.abs(delta) < deadBandPx) return null;

  const targetTop = tg.y;
  const targetBottom = tg.y + (tg.h || 0);
  const nextKids = kids.map((x) => {
    if (x.id === blockId) return setBlockBp(x, breakpoint, { h: rounded });
    const g = resolveBlockAtBreakpoint(x, breakpoint);
    if (!g || g.hidden) return x;
    const gBottom = g.y + (g.h || 0);
    // (2) Block entirely below the target -> shift down by delta.
    if (targetBottom <= g.y) {
      return setBlockBp(x, breakpoint, { y: Math.round(g.y + delta) });
    }
    // (3) Section background that contains the target -> grow by delta so its
    // stored height tracks the content and is persisted (grow-only; unchanged).
    if (
      x.type === BLOCK_TYPES.SECTION &&
      targetTop >= g.y &&
      targetBottom <= gBottom
    ) {
      return setBlockBp(x, breakpoint, { h: Math.round((g.h || 0) + delta) });
    }
    // (4) Box background that contains the target -> re-anchor to the deepest
    // contained content via the shared formula (Task #2680), NOT the isolated
    // target delta. This keeps the baked box height identical to what the public
    // renderer computes, and stops a box with several auto-height blocks (or one
    // whose content shrinks) from drifting between builder and front-end.
    if (
      x.type === BLOCK_TYPES.BOX &&
      targetTop >= g.y &&
      targetBottom <= gBottom
    ) {
      const newH = Math.round(boxReanchorHeight({
        kids,
        box: x,
        boxGeom: g,
        breakpoint,
        getDefinition,
        targetId: blockId,
        targetMeasuredH: rounded,
      }));
      return setBlockBp(x, breakpoint, { h: newH });
    }
    return x;
  });

  return setRootChildren(design, nextKids);
}
