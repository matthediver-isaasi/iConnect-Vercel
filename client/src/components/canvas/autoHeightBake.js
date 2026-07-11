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

// Pure bake planner. Given a design and a settled measurement, returns the next
// design with the reflow baked in, or `null` if nothing should change (block
// gone/hidden, card block, or delta inside the dead-band). Mirrors
// AccordionReflowContext exactly so there is zero visual change:
//   1. set the target's own h to the measured height,
//   2. push every block entirely below it down by the delta, and
//   3. grow every Section / Box that geometrically contains it by the delta.
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
    // (3) Container background (section or box) that contains the target ->
    // grow by delta so its stored height tracks the content and is persisted.
    if (
      (x.type === BLOCK_TYPES.SECTION || x.type === BLOCK_TYPES.BOX) &&
      targetTop >= g.y &&
      targetBottom <= gBottom
    ) {
      return setBlockBp(x, breakpoint, { h: Math.round((g.h || 0) + delta) });
    }
    return x;
  });

  return setRootChildren(design, nextKids);
}
