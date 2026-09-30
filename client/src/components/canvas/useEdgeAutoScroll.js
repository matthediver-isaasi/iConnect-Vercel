import { useCallback, useEffect, useMemo, useRef } from 'react';

// Edge auto-scroll for the canvas editor (Task #1668).
//
// While dragging a block (native pointer drag on the stage) or a new block
// from the palette (dnd-kit), moving the pointer near an edge of the
// scrollable canvas viewport should scroll the view in that direction so the
// drop point can be anywhere in one continuous motion.
//
// The loop is driven by requestAnimationFrame so it keeps scrolling even while
// the pointer is held still inside the edge zone (no pointermove fires then).
// Speed ramps up the closer the pointer is to the edge. The loop runs
// continuously between `update()` and `stop()` and is a cheap no-op when the
// pointer is outside every edge zone.

const EDGE_THRESHOLD = 56; // px from the viewport edge where scrolling kicks in
const MAX_SPEED = 24; // px per frame at the very edge
const MIN_SPEED = 2; // px per frame just inside the threshold

// Map proximity (0 at threshold edge, 1 at the container edge) to a speed with
// an ease-in curve so it ramps up smoothly the closer you get.
function speedFor(proximity) {
  const eased = proximity * proximity;
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * eased;
}

export default function useEdgeAutoScroll(scrollContainerRef) {
  const pointerRef = useRef(null); // latest { x, y } in client coords
  const onTickRef = useRef(null); // optional callback fired after a scroll step
  const rafRef = useRef(null);

  const stop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pointerRef.current = null;
    onTickRef.current = null;
  }, []);

  const tick = useCallback(() => {
    const el = scrollContainerRef?.current;
    const pt = pointerRef.current;
    if (!el || !pt) {
      rafRef.current = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    let dx = 0;
    let dy = 0;

    const maxScrollTop = el.scrollHeight - el.clientHeight;
    const maxScrollLeft = el.scrollWidth - el.clientWidth;

    // Vertical
    const distTop = pt.y - rect.top;
    const distBottom = rect.bottom - pt.y;
    if (distTop < EDGE_THRESHOLD && el.scrollTop > 0) {
      const proximity = Math.min(1, (EDGE_THRESHOLD - distTop) / EDGE_THRESHOLD);
      dy = -speedFor(proximity);
    } else if (distBottom < EDGE_THRESHOLD && el.scrollTop < maxScrollTop) {
      const proximity = Math.min(1, (EDGE_THRESHOLD - distBottom) / EDGE_THRESHOLD);
      dy = speedFor(proximity);
    }

    // Horizontal
    const distLeft = pt.x - rect.left;
    const distRight = rect.right - pt.x;
    if (distLeft < EDGE_THRESHOLD && el.scrollLeft > 0) {
      const proximity = Math.min(1, (EDGE_THRESHOLD - distLeft) / EDGE_THRESHOLD);
      dx = -speedFor(proximity);
    } else if (distRight < EDGE_THRESHOLD && el.scrollLeft < maxScrollLeft) {
      const proximity = Math.min(1, (EDGE_THRESHOLD - distRight) / EDGE_THRESHOLD);
      dx = speedFor(proximity);
    }

    if (dx !== 0 || dy !== 0) {
      if (dx !== 0) el.scrollLeft += dx;
      if (dy !== 0) el.scrollTop += dy;
      if (typeof onTickRef.current === 'function') {
        try { onTickRef.current(); } catch { /* ignore */ }
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [scrollContainerRef]);

  // Report the live pointer position. Starts the loop on first call and keeps
  // it running until stop() is invoked. `onTick` (optional) is called after each
  // frame that actually scrolled, so callers can recompute drag previews
  // against the new scroll offset.
  const update = useCallback((clientX, clientY, onTick) => {
    pointerRef.current = { x: clientX, y: clientY };
    if (typeof onTick === 'function') onTickRef.current = onTick;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  // Guard against leaked frames on unmount.
  useEffect(() => stop, [stop]);

  // Stable object so consumers can list it in effect deps without re-running.
  return useMemo(() => ({ update, stop }), [update, stop]);
}
