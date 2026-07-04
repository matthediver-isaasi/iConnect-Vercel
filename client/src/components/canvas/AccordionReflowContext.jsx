import {
  createContext,
  useContext,
  useCallback,
  useMemo,
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
   * Group measured (auto-height) blocks into "rows" by overlapping stored
   * vertical spans. Horizontally-adjacent blocks — e.g. a row of cards that all
   * share the same stored `y` — collapse into ONE row that grows by its TALLEST
   * member, not the sum of every member. Without this, a 3-column card row where
   * each card grew by N px would push everything below by 3N px (and stack extra
   * space between rows). A lone full-width block (text / accordion) forms its own
   * single-member row, so their reflow behaviour is unchanged.
   *
   * Each group is { top, bottom, growth } in STORED coordinates, where `growth`
   * is the signed max height delta (measured − stored) across the row.
   */
  const rowGroups = useMemo(() => {
    if (measuredHeights.size === 0) return [];
    const entries = [];
    for (const [id, measuredH] of measuredHeights) {
      const block = blocks.find((b) => b.id === id);
      if (!block) continue;
      const g = resolveGeom(block);
      if (!g || g.hidden) continue;
      entries.push({ top: g.y, bottom: g.y + g.h, growth: measuredH - g.h });
    }
    if (entries.length === 0) return [];
    entries.sort((a, b) => a.top - b.top);
    const groups = [];
    let cur = null;
    for (const e of entries) {
      if (cur && e.top < cur.bottom) {
        // Vertical spans overlap → same row band.
        cur.top = Math.min(cur.top, e.top);
        cur.bottom = Math.max(cur.bottom, e.bottom);
        cur.growth = Math.max(cur.growth, e.growth);
      } else {
        cur = { top: e.top, bottom: e.bottom, growth: e.growth };
        groups.push(cur);
      }
    }
    return groups;
  }, [measuredHeights, blocks, resolveGeom]);

  /**
   * Returns the total downward offset (px) that should be applied to a block
   * whose stored top edge is at storedY.
   *
   * Only counts row groups whose stored *bottom* edge sits at or above storedY —
   * i.e. rows that are entirely above the target block. A block is never pushed
   * by its own row (that row's bottom is below the block's top).
   */
  const getOffset = useCallback(
    (blockId, storedY) => {
      if (rowGroups.length === 0) return 0;
      let offset = 0;
      for (const grp of rowGroups) {
        if (grp.bottom <= storedY) offset += grp.growth;
      }
      return offset;
    },
    [rowGroups],
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
    for (const grp of rowGroups) total += grp.growth;
    return total;
  }, [rowGroups]);

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
      if (!sectionGeom || rowGroups.length === 0) return 0;
      let total = 0;
      for (const grp of rowGroups) {
        // Row is contained within the section if its stored span fits inside it.
        if (grp.top >= sectionGeom.y && grp.bottom <= sectionGeom.y + sectionGeom.h) {
          total += grp.growth;
        }
      }
      return total;
    },
    [rowGroups],
  );

  return (
    <AccordionReflowCtx.Provider value={{ reportHeight, getOffset, getMeasuredHeight, getTotalGrowth, getSectionGrowth }}>
      {children}
    </AccordionReflowCtx.Provider>
  );
}
