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
import { getBlockDefinition } from './blocks/registry';

const AccordionReflowCtx = createContext(null);

export function useAccordionReflow() {
  return useContext(AccordionReflowCtx);
}

/**
 * Measure an element's margin-inclusive vertical footprint for reflow.
 *
 * `getBoundingClientRect().height` reports the border box only — it excludes
 * CSS margins by definition. Typography styles apply their configured
 * "Margin Bottom" as a `margin-bottom` on this very measured element, so the
 * reflow system would otherwise stack the block below at the border-box bottom
 * and drop the margin. Add the computed `margin-bottom` back so the reported
 * footprint is the margin-inclusive bounds. A zero margin adds nothing, so a
 * block with no typography bottom margin (e.g. the accordion) is unchanged.
 */
function measureReflowHeight(el) {
  if (!el) return 0;
  const h = el.getBoundingClientRect().height;
  if (h <= 0) return h;
  let marginBottom = 0;
  try {
    const cs = window.getComputedStyle(el);
    const mb = parseFloat(cs.marginBottom);
    if (Number.isFinite(mb) && mb > 0) marginBottom = mb;
  } catch { /* getComputedStyle unavailable (SSR) — border box only */ }
  return h + marginBottom;
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
 * The reported height is margin-inclusive (see measureReflowHeight) so a
 * typography style's Margin Bottom is honoured when stacking the block below.
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
    const h = measureReflowHeight(containerRef.current);
    if (h > 0) reflow.reportHeight(blockId, Math.round(h));
  }, []); // intentionally mount-only; ResizeObserver below handles ongoing changes

  useEffect(() => {
    if (!reflow || !containerRef.current) return;
    const el = containerRef.current;
    const report = () => {
      const h = measureReflowHeight(el);
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
export function AccordionReflowProvider({ children, blocks, resolveGeom, editorMode = false, breakpoint, onMeasure }) {
  const [measuredHeights, setMeasuredHeights] = useState(() => new Map());
  // Smallest height ever measured per block = its collapsed (baseline) rendered
  // height. Accordions mount fully collapsed, so the first measurement is their
  // collapsed state. Push-down growth for auto-height blocks is measured from
  // this baseline rather than the stored box height, so expanding an accordion
  // whose stored box is taller than its collapsed state still pushes blocks
  // below down (see rowGroups). Kept in a ref because it only ever shrinks and
  // is read during the measuredHeights-driven recompute.
  const baselineHeightsRef = useRef(new Map());

  // The collapsed baseline is breakpoint-specific (an accordion question can
  // wrap to more lines on a narrow layout, making its collapsed state taller).
  // Clear the accumulated minimums whenever the active breakpoint changes so a
  // baseline captured at one width can't produce a phantom push-down at
  // another. The ResizeObserver re-reports every block's height right after the
  // width change, repopulating the map for the new breakpoint.
  useEffect(() => {
    baselineHeightsRef.current = new Map();
  }, [breakpoint]);

  // Optional editor hook: whenever an auto-height block reports a rendered
  // height we forward it so the editor can commit that height into the block's
  // stored geometry (published render passes no onMeasure, so it stays a pure
  // read-time reflow). Held in a ref so reportHeight keeps a stable identity
  // and the measurement effects don't re-bind when onMeasure changes.
  const onMeasureRef = useRef(onMeasure);
  useEffect(() => { onMeasureRef.current = onMeasure; }, [onMeasure]);

  const reportHeight = useCallback((blockId, height) => {
    const rounded = Math.round(height);
    const prevBaseline = baselineHeightsRef.current.get(blockId);
    if (prevBaseline === undefined || rounded < prevBaseline) {
      baselineHeightsRef.current.set(blockId, rounded);
    }
    setMeasuredHeights((prev) => {
      if (prev.get(blockId) === rounded) return prev;
      const next = new Map(prev);
      next.set(blockId, rounded);
      return next;
    });
    if (onMeasureRef.current) onMeasureRef.current(blockId, rounded);
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
      // Reference height for computing push-down growth (how far this block's
      // rendered bottom extends past the point below which neighbours sit at
      // their stored positions).
      //
      // For plain auto-height blocks (accordion, text) whose content itself
      // grows/shrinks, measure growth from the block's own COLLAPSED BASELINE
      // (smallest height ever observed) rather than its stored box height. This
      // restores the accordion push-down removed in #2333: a stored box taller
      // than the collapsed state no longer clamps expansion to 0. The reference
      // is also capped at the stored box height so a block whose collapsed
      // content already overflows its box still pushes neighbours down (matching
      // #2333's static-overflow behaviour). Static content keeps measured ==
      // baseline, so its growth is unchanged — author-intended gaps are
      // preserved and never pulled up.
      //
      // Cards (autoHeight + cardGrow) are excluded: their stored/manual box
      // height is the author's intended size and must stay the reference, so
      // row equalisation and manual resizes are untouched.
      const def = getBlockDefinition(block.type);
      const baseline = baselineHeightsRef.current.get(id);
      const useBaseline = !!def?.autoHeight && !def?.cardGrow && Number.isFinite(baseline);
      const referenceH = useBaseline ? Math.min(baseline, g.h) : g.h;
      entries.push({ id, top: g.y, bottom: g.y + g.h, refBottom: g.y + referenceH, effectiveH });
    }
    if (entries.length === 0) return [];
    entries.sort((a, b) => a.top - b.top);
    const groups = [];
    let cur = null;
    for (const e of entries) {
      if (cur && e.top < cur.refBottom) {
        // Row membership is decided by overlap with the running REFERENCE band
        // (`cur.refBottom`), not the stored box bottom. For cards the reference
        // is the stored bottom (refBottom === bottom), so a row of cards that
        // share the same stored `y` still collapses into ONE row whose rendered
        // height is the TALLEST member's — auto-equalising card heights is
        // unchanged.
        //
        // For an auto-height accordion whose stored box is far taller than its
        // collapsed state, the reference is the COLLAPSED-baseline bottom. A
        // block authored just under the accordion's collapsed state — but still
        // inside its oversized stored box — therefore starts BELOW the
        // reference band and is NOT merged in. It forms its own row so the
        // expanding accordion pushes it down (matching the getOffset test
        // below), instead of being swallowed into the accordion's row and
        // silently overlapped.
        cur.top = Math.min(cur.top, e.top);
        cur.bottom = Math.max(cur.bottom, e.bottom);
        cur.refBottom = Math.max(cur.refBottom, e.refBottom);
        cur.renderedHeight = Math.max(cur.renderedHeight, e.effectiveH);
        cur.ids.push(e.id);
      } else {
        cur = { top: e.top, bottom: e.bottom, refBottom: e.refBottom, renderedHeight: e.effectiveH, ids: [e.id] };
        groups.push(cur);
      }
    }
    // Growth = how far the row's rendered bottom extends past its REFERENCE
    // bottom band. For cards the reference is the stored bottom; for plain
    // auto-height blocks it is the collapsed-baseline bottom (so an accordion
    // whose stored box is taller than its collapsed state still pushes blocks
    // below down when expanded — see the referenceH comment above).
    // PUSH-DOWN-ONLY: clamped to be non-negative so a row that renders SHORTER
    // than its reference never pulls the blocks below it upward. The editor is
    // the source of truth for stored gaps and no longer reflows, so the public
    // renderer must preserve those gaps rather than collapse trailing
    // whitespace. Positive growth (accordion expand, a card row grown to its
    // tallest member) still pushes blocks below down. Computed after merges so
    // `refBottom` is final.
    for (const grp of groups) {
      grp.growth = Math.max(0, (grp.top + grp.renderedHeight) - grp.refBottom);
    }
    return groups;
  }, [measuredHeights, blocks, resolveGeom]);

  /**
   * Returns the total downward offset (px) that should be applied to a block
   * whose stored top edge is at storedY.
   *
   * A row group pushes a target block down when the group's REFERENCE bottom
   * (`refBottom` — the point from which its growth is measured) sits at or above
   * storedY. This MUST use the same reference the growth is measured from, not
   * the stored box bottom: an accordion's stored box is frequently far taller
   * than its collapsed state, and blocks authored to sit just under the
   * collapsed accordion land in the band [refBottom, bottom). Testing against
   * the stored `bottom` would skip exactly those blocks, so the expanding
   * accordion would grow straight through and overlap them. Testing against
   * `refBottom` pushes them down as intended.
   *
   * A block is never pushed by its own row: every member's stored top is < its
   * row's refBottom (a member only merges when its top is within the running
   * reference band), so `refBottom <= storedY` is always false for members.
   * Push-down growth is clamped non-negative in rowGroups, so this only ever
   * moves blocks down, never up.
   */
  const getOffset = useCallback(
    (blockId, storedY) => {
      // Editor mode disables all push-down displacement: blocks render at their
      // stored positions so dragging/dropping never shifts unrelated blocks.
      if (editorMode) return 0;
      if (rowGroups.length === 0) return 0;
      let offset = 0;
      for (const grp of rowGroups) {
        if (grp.refBottom <= storedY) offset += grp.growth;
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
   * Net height change (px) that should be added to a CONTAINING background-style
   * block's rendered height — a Section, a decorative Box, or any future shape
   * type that wraps other blocks. Non-negative (per-row growth is
   * push-down-only), so a container never shrinks to close author-intended gaps
   * around its contained blocks; it only grows when contained content expands.
   * A block is "inside" the container when its stored top ≥ container.y AND its
   * stored bottom ≤ container.y + container.h.
   *
   * This is the generalisation of the original section-only growth: the
   * containment test is identical, so `box` (and future background types) can
   * share it. A text block sitting on top of a box therefore grows the box
   * taller as it gains lines, keeping the box wrapped around the text.
   *
   * @param containerBlock – the containing canvas block (section, box, …)
   * @param containerGeom  – breakpoint-resolved geometry { x, y, w, h } of the
   *                         container (avoids re-resolving inside the hook)
   */
  const getContainerGrowth = useCallback(
    (containerBlock, containerGeom) => {
      // Editor mode: containers keep their stored height (no auto-grow); the
      // editor bakes committed heights into stored geometry instead.
      if (editorMode) return 0;
      if (!containerGeom || rowGroups.length === 0) return 0;
      let total = 0;
      for (const grp of rowGroups) {
        // Row is contained within the container if its stored span fits inside.
        if (grp.top >= containerGeom.y && grp.bottom <= containerGeom.y + containerGeom.h) {
          total += grp.growth;
        }
      }
      return total;
    },
    [editorMode, rowGroups],
  );

  // Back-compat alias: sections are just one kind of container.
  const getSectionGrowth = getContainerGrowth;

  return (
    <AccordionReflowCtx.Provider value={{ reportHeight, getOffset, getMeasuredHeight, getContentHeight, getRowHeight, getTotalGrowth, getSectionGrowth, getContainerGrowth }}>
      {children}
    </AccordionReflowCtx.Provider>
  );
}
