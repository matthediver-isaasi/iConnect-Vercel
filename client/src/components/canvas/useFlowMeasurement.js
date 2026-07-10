import { useCallback, useEffect, useRef, useState } from 'react';

// Task #2569 (Flow Step 3) — live DOM measurement for the pure flow engine.
//
// `resolveFlowLayout` is deterministic and never touches the DOM: it takes a
// `measured` map ({ [nodeId]: { height } }) and stacks everything off those
// heights. This hook is the browser-only half that PRODUCES that map. It
// observes each rendered flow leaf with a single ResizeObserver and reports
// its live rendered height, so auto-height blocks (text, accordions, images
// that load late, fonts that swap in) reflow the blocks below them in real
// time as the content changes.
//
// Heights are read from `offsetHeight`, which is the element's own CSS-pixel
// layout height and is NOT affected by an ancestor `transform: scale()` (the
// builder zooms the stage that way). That keeps measurements in stage
// coordinates regardless of the current zoom level.
//
// `resetKey` (the active breakpoint) clears the map whenever it changes: a
// height measured at the desktop width is meaningless at the mobile width, so
// on a breakpoint switch we drop the stale heights and re-measure whatever is
// still mounted on the next frame.
export function useFlowMeasurement(resetKey) {
  const [measured, setMeasured] = useState({});

  const observerRef = useRef(null);
  // element -> nodeId, so the observer callback can map a resized element back
  // to the flow node it belongs to.
  const elToId = useRef(new Map());
  // nodeId -> element, so a ref callback can detach a previously observed
  // element when React swaps it, and the reset effect can re-measure.
  const idToEl = useRef(new Map());

  const applyHeight = useCallback((id, height) => {
    if (!id || !Number.isFinite(height)) return;
    setMeasured((prev) => {
      const cur = prev[id];
      // Sub-pixel jitter must not trigger a re-render/reflow loop.
      if (cur && Math.abs(cur.height - height) < 0.5) return prev;
      return { ...prev, [id]: { height } };
    });
  }, []);

  const getObserver = useCallback(() => {
    if (observerRef.current) return observerRef.current;
    if (typeof ResizeObserver === 'undefined') return null;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = elToId.current.get(entry.target);
        if (id) applyHeight(id, entry.target.offsetHeight);
      }
    });
    observerRef.current = ro;
    return ro;
  }, [applyHeight]);

  // Ref-callback factory: attach `measureRef(nodeId)` to a leaf's measured
  // wrapper. Handles element swaps and unmounts, and takes a synchronous first
  // measurement so the very first layout pass already has a real height.
  const measureRef = useCallback((id) => (el) => {
    const ro = getObserver();
    const prevEl = idToEl.current.get(id);
    if (prevEl && prevEl !== el) {
      elToId.current.delete(prevEl);
      ro?.unobserve(prevEl);
    }
    if (el) {
      idToEl.current.set(id, el);
      elToId.current.set(el, id);
      ro?.observe(el);
      applyHeight(id, el.offsetHeight);
    } else {
      idToEl.current.delete(id);
      if (prevEl) {
        elToId.current.delete(prevEl);
        ro?.unobserve(prevEl);
      }
    }
  }, [getObserver, applyHeight]);

  // Drop stale heights on a breakpoint switch, then re-measure the still-
  // mounted elements once the browser has laid them out at the new width.
  useEffect(() => {
    setMeasured({});
    if (typeof requestAnimationFrame !== 'function') return undefined;
    const raf = requestAnimationFrame(() => {
      for (const [id, el] of idToEl.current) {
        if (el) applyHeight(id, el.offsetHeight);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [resetKey, applyHeight]);

  // Tear the observer down on unmount.
  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    elToId.current.clear();
    idToEl.current.clear();
  }, []);

  return { measured, measureRef };
}

export default useFlowMeasurement;
