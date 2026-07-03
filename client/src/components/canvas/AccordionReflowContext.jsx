import {
  createContext,
  useContext,
  useCallback,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
} from 'react';

const AccordionReflowCtx = createContext(null);

export function useAccordionReflow() {
  return useContext(AccordionReflowCtx);
}

/**
 * Shared auto-height reflow measurement for canvas blocks that report their
 * rendered height back to the AccordionReflowContext (accordion, text, …).
 *
 * Returns a ref to attach to the measured element. It encapsulates:
 *   - a synchronous mount-only useLayoutEffect measurement (so blocks below
 *     are already at their correct positions on the first committed frame,
 *     avoiding a visible layout jump when stored height != natural height), and
 *   - an ongoing ResizeObserver that re-reports on any subsequent size change
 *     (expand/collapse, content edits, width-driven rewraps, …).
 *
 * Safe to use even when there is no surrounding provider (reflow is null): the
 * effects simply no-op.
 */
export function useReportReflowHeight(blockId) {
  const reflow = useAccordionReflow();
  const containerRef = useRef(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!reflow || !containerRef.current) return;
    const h = containerRef.current.getBoundingClientRect().height;
    if (h > 0) reflow.reportHeight(blockId, Math.round(h));
  }, []); // intentionally mount-only; ResizeObserver below handles ongoing changes

  useEffect(() => {
    if (!reflow || !containerRef.current) return;
    const el = containerRef.current;
    const report = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) reflow.reportHeight(blockId, Math.round(h));
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reflow, blockId]);

  return containerRef;
}

/**
 * Tracks the measured (rendered) heights of auto-height blocks (accordion)
 * and computes cumulative downward offsets for blocks positioned below them.
 *
 * Props:
 *   blocks      – the flat list of canvas blocks being rendered
 *   resolveGeom – (block) => { x, y, w, h, hidden }  (breakpoint-resolved)
 */
export function AccordionReflowProvider({ children, blocks, resolveGeom }) {
  const [measuredHeights, setMeasuredHeights] = useState(() => new Map());

  const reportHeight = useCallback((blockId, height) => {
    const rounded = Math.round(height);
    setMeasuredHeights((prev) => {
      if (prev.get(blockId) === rounded) return prev;
      const next = new Map(prev);
      next.set(blockId, rounded);
      return next;
    });
  }, []);

  /**
   * Returns the total downward offset (px) that should be applied to a block
   * whose stored top edge is at storedY.
   *
   * Only counts accordion blocks whose stored *bottom* edge sits at or above
   * storedY — i.e. blocks that are entirely above the target block.
   */
  const getOffset = useCallback(
    (blockId, storedY) => {
      if (measuredHeights.size === 0) return 0;
      let offset = 0;
      for (const [id, measuredH] of measuredHeights) {
        if (id === blockId) continue;
        const block = blocks.find((b) => b.id === id);
        if (!block) continue;
        const g = resolveGeom(block);
        if (!g || g.hidden) continue;
        const storedBottom = g.y + g.h;
        if (storedBottom <= storedY) {
          offset += measuredH - g.h;
        }
      }
      return offset;
    },
    [measuredHeights, blocks, resolveGeom],
  );

  /** Measured height for a specific block (undefined if not yet reported). */
  const getMeasuredHeight = useCallback(
    (blockId) => measuredHeights.get(blockId),
    [measuredHeights],
  );

  /**
   * Net signed height change (px) across all auto-height blocks.
   * Positive when accordions are expanded, negative when smaller than stored.
   * Use this to extend the page-stage minHeight (only when positive — shrinking
   * within the existing CSS height requires no override).
   */
  const getTotalGrowth = useCallback(() => {
    let total = 0;
    for (const [id, measuredH] of measuredHeights) {
      const block = blocks.find((b) => b.id === id);
      if (!block) continue;
      const g = resolveGeom(block);
      if (!g || g.hidden) continue;
      total += measuredH - g.h;
    }
    return total;
  }, [measuredHeights, blocks, resolveGeom]);

  /**
   * Net signed height change (px) that should be added to a containing
   * Section block's rendered height. A block is "inside" the section when its
   * stored top ≥ section.y AND its stored bottom ≤ section.y + section.h.
   *
   * @param sectionBlock  – the Section canvas block
   * @param sectionGeom   – breakpoint-resolved geometry { x, y, w, h } of
   *                        the section (avoids re-resolving inside the hook)
   */
  const getSectionGrowth = useCallback(
    (sectionBlock, sectionGeom) => {
      if (!sectionGeom || measuredHeights.size === 0) return 0;
      let total = 0;
      for (const [id, measuredH] of measuredHeights) {
        if (id === sectionBlock.id) continue;
        const block = blocks.find((b) => b.id === id);
        if (!block) continue;
        const g = resolveGeom(block);
        if (!g || g.hidden) continue;
        // Block is contained within the section if its geometry fits inside it.
        if (g.y >= sectionGeom.y && g.y + g.h <= sectionGeom.y + sectionGeom.h) {
          total += measuredH - g.h;
        }
      }
      return total;
    },
    [measuredHeights, blocks, resolveGeom],
  );

  return (
    <AccordionReflowCtx.Provider value={{ reportHeight, getOffset, getMeasuredHeight, getTotalGrowth, getSectionGrowth }}>
      {children}
    </AccordionReflowCtx.Provider>
  );
}
