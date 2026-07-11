// Runtime guards for baking an auto-height block's measured height into stored
// Canvas geometry. The *pure* bake decision (card exclusion, delta/dead-band,
// block-below push + section grow, suspect-shrink debounce window) lives in
// ./autoHeightBake.js and is unit-tested without a DOM. This hook holds the
// three RUNTIME-only guards that stop a transient bad measurement from ever
// reaching that bake — they need refs / effects / the DOM, so they were
// impossible to cover from the pure module:
//
//   Gate 1 — settle + breakpoint re-arm: never bake a measurement taken before
//     web fonts + the stage's images have settled, and re-close that gate on
//     every breakpoint change (a switch re-lays-out every block at a new width)
//     while cancelling any pending commit from the previous breakpoint.
//   Gate 2 — author intent: a mount-time mechanical re-measure must never flip
//     isDirty / trip the 2s autosave, or a hard refresh would silently
//     overwrite a correctly-saved page with zero user interaction.
//   Gate 3 — content ready re-check: at bake time drop the measurement if the
//     block's own <img>s are still loading or a web font is mid-swap.
//
// Extracted from CanvasBuilder.jsx so it imports ONLY React + the pure module
// (no block registry, no API clients) and can therefore be mounted in a tiny
// jsdom harness for automated coverage. See useAutoHeightBake.test.mjs and
// .agents/memory/canvas-autoheight-commit.md.
import { useRef, useCallback, useEffect } from 'react';
import { planAutoHeightBake, autoHeightDebounceDelay } from './autoHeightBake.js';

// Gate 3 helper, pulled out so it is exercisable with a plain DOM element.
// `element` is the block's DOM node (or null when it isn't on the stage yet);
// `fontsStatus` is `document.fonts.status` (or undefined when unavailable). A
// height measured while a font is swapping or an image is still decoding is
// transiently WRONG, so we refuse it; the ResizeObserver re-reports once the
// content settles, so the correct height still bakes later.
export function isMeasuredContentReady({ fontsStatus, element }) {
  if (fontsStatus === 'loading') return false;
  if (!element || typeof element.querySelectorAll !== 'function') return true;
  for (const img of element.querySelectorAll('img')) {
    if (!img.complete) return false;
  }
  return true;
}

// Gate 1 + Gate 2 (+ basic sanity): whether a reported measurement is even
// allowed to be SCHEDULED for a bake. Kept pure so the settle/author-intent
// decision is testable directly, and so the effect that flips `layoutSettled`
// on breakpoint change has an unambiguous contract.
export function shouldScheduleAutoHeightCommit({ blockId, measuredHeight, layoutSettled, authorEdited }) {
  if (!blockId || !Number.isFinite(measuredHeight)) return false;
  if (!layoutSettled) return false; // Gate 1 — settle (re-armed per breakpoint)
  if (!authorEdited) return false; // Gate 2 — author intent
  if (Math.round(measuredHeight) <= 0) return false;
  return true;
}

export default function useAutoHeightBake({
  breakpoint,
  designRef,
  setDesign,
  skipHistoryRef,
  authorEditedRef,
  stageWrapperRef,
  getDefinition,
}) {
  const autoHeightTimers = useRef(new Map());
  // True once web fonts and the stage's initial images have settled. Before
  // that, measured auto-height reflects fallback-font / undecoded-image metrics
  // that differ from the real render, so any height baked from them would be
  // wrong. Re-armed on every breakpoint change.
  const layoutSettledRef = useRef(false);

  // Gate 3 — content ready: checked for the specific block at bake time (unlike
  // the global settle gate, armed once per breakpoint), so a late image/font on
  // a block that only just rendered or scrolled into view is still caught.
  const isBlockContentReady = useCallback((blockId) => {
    const fontsStatus =
      typeof document !== 'undefined' && document.fonts ? document.fonts.status : undefined;
    const wrap = stageWrapperRef.current;
    let el = null;
    if (wrap) {
      try {
        const sel = (typeof CSS !== 'undefined' && CSS.escape)
          ? `[data-block-id="${CSS.escape(String(blockId))}"]`
          : `[data-block-id="${String(blockId)}"]`;
        el = wrap.querySelector(sel);
      } catch {
        el = null;
      }
    }
    return isMeasuredContentReady({ fontsStatus, element: el });
  }, [stageWrapperRef]);

  const commitAutoHeight = useCallback((blockId, measuredHeight) => {
    // Gates 1 + 2 (settle + author intent) + basic sanity.
    if (!shouldScheduleAutoHeightCommit({
      blockId,
      measuredHeight,
      layoutSettled: layoutSettledRef.current,
      authorEdited: authorEditedRef.current,
    })) return;
    const rounded = Math.round(measuredHeight);
    // Decide the settle window from the stored height at schedule time: a
    // suspect shrink waits longer so a transient short measurement is corrected
    // (its debounce reset) by the real height before it can ever bake.
    const delay = autoHeightDebounceDelay(designRef.current, blockId, breakpoint, rounded);
    const timers = autoHeightTimers.current;
    if (timers.has(blockId)) clearTimeout(timers.get(blockId));
    timers.set(blockId, setTimeout(() => {
      timers.delete(blockId);
      // Gate 3 — content ready: drop the measurement if the block's own images
      // are still loading or fonts are mid-swap. The ResizeObserver re-reports
      // once they settle, so the correct height still bakes later; a transient
      // wrong height never does.
      if (!isBlockContentReady(blockId)) return;
      skipHistoryRef.current = true;
      setDesign((prev) => {
        // Pure bake decision (card exclusion, delta/dead-band, block-below push
        // + section grow) lives in ./autoHeightBake so it is unit-tested without
        // a DOM. Returns null when nothing should change.
        const next = planAutoHeightBake({
          design: prev,
          blockId,
          breakpoint,
          measuredHeight: rounded,
          getDefinition,
        });
        if (!next) { skipHistoryRef.current = false; return prev; }
        return next;
      });
    }, delay));
  }, [breakpoint, designRef, setDesign, skipHistoryRef, authorEditedRef, isBlockContentReady, getDefinition]);

  // Cancel any pending auto-height commits on unmount.
  useEffect(() => () => {
    for (const t of autoHeightTimers.current.values()) clearTimeout(t);
    autoHeightTimers.current.clear();
  }, []);

  // Gate 1 — flip the settle gate once web fonts and the stage's initial images
  // have loaded. A hard timeout guarantees the gate opens even if fonts.ready
  // never resolves. Re-armed on every breakpoint change (not just first mount):
  // switching breakpoint re-lays-out every block at a new width (text rewraps,
  // images re-fit), so measurements taken before that new layout settles are
  // wrong. Closing the gate here and only re-opening once fonts + the new
  // breakpoint's images have loaded stops a mid-switch measurement from baking.
  // Pending commits from the previous breakpoint are cancelled so they can't
  // fire against the new layout.
  useEffect(() => {
    let cancelled = false;
    layoutSettledRef.current = false;
    for (const t of autoHeightTimers.current.values()) clearTimeout(t);
    autoHeightTimers.current.clear();
    const markSettled = () => {
      if (cancelled) return;
      // One extra frame so a ResizeObserver fired by the font swap / image
      // decode has flushed before commits are allowed through.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!cancelled) layoutSettledRef.current = true;
        }));
      } else {
        layoutSettledRef.current = true;
      }
    };
    const waits = [];
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      waits.push(document.fonts.ready.catch(() => {}));
    }
    const wrap = stageWrapperRef.current;
    if (wrap) {
      for (const img of Array.from(wrap.querySelectorAll('img'))) {
        if (img.complete) continue;
        waits.push(new Promise((res) => {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        }));
      }
    }
    Promise.all(waits).then(markSettled);
    const t = setTimeout(markSettled, 4000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [breakpoint, stageWrapperRef]);

  return { commitAutoHeight, layoutSettledRef, isBlockContentReady };
}
