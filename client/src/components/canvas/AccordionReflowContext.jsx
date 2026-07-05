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
 * Height reporting for CARD blocks, which support vertical growth AND row
 * auto-equalisation. Unlike useReportReflowHeight (which measures one element),
 * a card must report its NATURAL content height even while its box is being
 * inflated to the row's tallest height. Inflating the box would otherwise feed
 * back into the measurement (min-height → measured height → row height → …),
 * pinning the row at its historical max and never shrinking.
 *
 * The card lays out an invisible flex spacer that absorbs any extra height
 * (pushing the CTA to the bottom). Natural content height is therefore
 *   outer.height − spacer.height
 * which stays equal to the content regardless of the applied row height, so the
 * measurement is non-circular.
 *
 * Returns:
 *   outerRef  – attach to the card's outer flex-column box.
 *   spacerRef – attach to the flex spacer between the body and the CTA.
 *   rowHeight – the equalised height to apply as min-height on the outer box
 *               (undefined until the row has been measured).
 */
export function useReportCardContentHeight(blockId) {
  const reflow = useAccordionReflow();
  const outerRef = useRef(null);
  const spacerRef = useRef(null);

  const report = useCallback(() => {
    if (!reflow || !outerRef.current) return;
    const outerH = outerRef.current.getBoundingClientRect().height;
    const spacerH = spacerRef.current ? spacerRef.current.getBoundingClientRect().height : 0;
    const natural = Math.round(outerH - spacerH);
    if (natural > 0) reflow.reportHeight(blockId, natural);
  }, [reflow, blockId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { report(); }, []); // mount-only; observer handles the rest

  useEffect(() => {
    if (!reflow) return;
    const els = [outerRef.current, spacerRef.current].filter(Boolean);
    if (els.length === 0) return;
    const observer = new ResizeObserver(report);
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [reflow, report]);

  const rowHeight = reflow ? reflow.getRowHeight(blockId) : undefined;
  return { outerRef, spacerRef, rowHeight };
}

/**
 * Tracks the measured (rendered) heights of auto-height blocks (accordion)
 * and computes cumulative downward offsets for blocks positioned below them.
 *
 * Props:
 *   blocks      – the flat list of canvas blocks being rendered
 *   resolveGeom – (block) => { x, y, w, h, hidden }  (breakpoint-resolved)
 */
export function AccordionReflowProvider({ children, blocks, resolveGeom, editorMode = false }) {
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
      // Effective height a block renders at:
      //   - its natural (measured) content height, floored by
      //   - an author-dragged explicit height (cards flagged manualHeight in
      //     their per-breakpoint geometry). A card can only ever GROW beyond
      //     its content, never shrink below it, so the floor is applied as a
      //     lower bound.
      const floor = (g.manualHeight && Number.isFinite(g.h)) ? g.h : 0;
      const effectiveH = Math.max(measuredH, floor);
      entries.push({ id, top: g.y, bottom: g.y + g.h, effectiveH });
    }
    if (entries.length === 0) return [];
    entries.sort((a, b) => a.top - b.top);
    const groups = [];
    let cur = null;
    for (const e of entries) {
      if (cur && e.top < cur.bottom) {
        // Vertical spans overlap → same row band. Horizontally-adjacent
        // members (a row of cards) collapse into one row whose rendered
        // height is the TALLEST member's — this is what auto-equalises card
        // heights across a row.
        cur.top = Math.min(cur.top, e.top);
        cur.bottom = Math.max(cur.bottom, e.bottom);
        cur.renderedHeight = Math.max(cur.renderedHeight, e.effectiveH);
        cur.ids.push(e.id);
      } else {
        cur = { top: e.top, bottom: e.bottom, renderedHeight: e.effectiveH, ids: [e.id] };
        groups.push(cur);
      }
    }
    // Growth = how far the row's rendered bottom extends past its stored
    // bottom band. PUSH-DOWN-ONLY: clamped to be non-negative so a row that
    // renders SHORTER than its stored allocation never pulls the blocks below
    // it upward. The editor is the source of truth for stored gaps and no
    // longer reflows, so the public renderer must preserve those gaps rather
    // than collapse trailing whitespace. Positive growth (accordion expand,
    // a card row grown to its tallest member) still pushes blocks below down.
    // Computed after merges so `bottom` is final.
    for (const grp of groups) {
      grp.growth = Math.max(0, (grp.top + grp.renderedHeight) - grp.bottom);
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
      // Editor mode disables all push-down displacement: blocks render at their
      // stored positions so dragging/dropping never shifts unrelated blocks.
      if (editorMode) return 0;
      if (rowGroups.length === 0) return 0;
      let offset = 0;
      for (const grp of rowGroups) {
        if (grp.bottom <= storedY) offset += grp.growth;
      }
      return offset;
    },
    [editorMode, rowGroups],
  );

  /** Measured height for a specific block (undefined if not yet reported). */
  const getMeasuredHeight = useCallback(
    (blockId) => measuredHeights.get(blockId),
    [measuredHeights],
  );

  /**
   * Natural (content) height a block was measured at — the LOWER bound a card
   * can be resized to. Alias of getMeasuredHeight, named for the resize clamp
   * so a card can never be dragged shorter than its content.
   */
  const getContentHeight = useCallback(
    (blockId) => measuredHeights.get(blockId),
    [measuredHeights],
  );

  /**
   * The height every card in a block's row should render at (the tallest
   * member's effective height). Returns undefined when the block is not part
   * of any measured row yet — callers then fall back to content-driven auto
   * height. This is what makes cards sharing a row render at equal height.
   */
  const getRowHeight = useCallback(
    (blockId) => {
      // Editor mode: no cross-row equalization. A card renders at its own
      // content height (auto) unless the author explicitly grew it, in which
      // case its stored manual height is applied as a min-height floor. This
      // keeps manually-resized cards from snapping back on drop while never
      // inflating a card to match its neighbours in the row.
      if (editorMode) {
        const block = blocks.find((b) => b.id === blockId);
        if (!block) return undefined;
        const g = resolveGeom(block);
        if (!g || g.hidden) return undefined;
        return (g.manualHeight && Number.isFinite(g.h)) ? g.h : undefined;
      }
      for (const grp of rowGroups) {
        if (grp.ids.includes(blockId)) return grp.renderedHeight;
      }
      return undefined;
    },
    [editorMode, blocks, resolveGeom, rowGroups],
  );

  /**
   * Net height change (px) across all auto-height blocks. Non-negative because
   * per-row growth is clamped push-down-only: positive when accordions are
   * expanded / a card row grew, zero otherwise. Use this to extend the
   * page-stage minHeight so pushed-down blocks are never clipped. It never
   * shrinks the stage (which would collapse author-intended gaps).
   */
  const getTotalGrowth = useCallback(() => {
    // Editor mode: stage height derives from stored geometry only.
    if (editorMode) return 0;
    let total = 0;
    for (const grp of rowGroups) total += grp.growth;
    return total;
  }, [editorMode, rowGroups]);

  /**
   * Net height change (px) that should be added to a containing Section
   * block's rendered height. Non-negative (per-row growth is push-down-only),
   * so a section never shrinks to close author-intended gaps around its
   * contained blocks; it only grows when contained content expands. A block is
   * "inside" the section when its stored top ≥ section.y AND its stored bottom
   * ≤ section.y + section.h.
   *
   * @param sectionBlock  – the Section canvas block
   * @param sectionGeom   – breakpoint-resolved geometry { x, y, w, h } of
   *                        the section (avoids re-resolving inside the hook)
   */
  const getSectionGrowth = useCallback(
    (sectionBlock, sectionGeom) => {
      // Editor mode: sections keep their stored height (no accordion auto-grow).
      if (editorMode) return 0;
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
    <AccordionReflowCtx.Provider value={{ reportHeight, getOffset, getMeasuredHeight, getContentHeight, getRowHeight, getTotalGrowth, getSectionGrowth }}>
      {children}
    </AccordionReflowCtx.Provider>
  );
}
