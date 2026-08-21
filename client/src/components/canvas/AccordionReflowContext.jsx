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
import { BLOCK_TYPES, blockIsFullWidthLike, isAspectHeightCarousel, resolveAspectReflowReferenceHeight } from '../../lib/canvasDesign';
import { computeCardReferenceHeight, normalizeMeasuredLength, updateReflowBaseline } from './autoHeightBake';
import {
  buildReflowRowGroups,
  computeReflowStageHeight,
  growthForContainedGeom,
  offsetForTargetGeom,
  reflowMemberIsContained,
} from './reflowStageHeight';

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
 *
 * `zoom` (Task #2699) normalizes the measurement back to true stage
 * coordinates. Editor zoom is a `transform: scale(zoom)` on the stage wrapper,
 * and `getBoundingClientRect()` returns dimensions AFTER that transform — so a
 * height measured at 150% zoom is inflated 1.5×. Dividing the border-box height
 * by the active zoom yields the un-scaled height that gets baked into stored
 * geometry, so zoom never influences the saved layout. The public renderer
 * never zooms (zoom defaults to 1), so its measurement is byte-unchanged.
 *
 * The `margin-bottom` read from `getComputedStyle` is the resolved CSS value in
 * layout pixels — it is NOT affected by the CSS transform — so it must be added
 * back WITHOUT dividing by zoom.
 */
export function measureReflowHeight(el, zoom = 1) {
  if (!el) return 0;
  const h = normalizeMeasuredLength(el.getBoundingClientRect().height, zoom);
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
 * `extraHeight` (Task #2612) folds the block's configured vertical padding —
 * `paddingTop + paddingBottom` from the inspector's Spacing panel — into the
 * reported footprint. The measured element is the block's INNER content, while
 * that padding is applied on the OUTER wrapper, so the raw measurement omits
 * it and blocks snapped below would overlap into the visible padding. This is
 * only added in EDITOR mode (where the reported height is baked into stored
 * geometry and drives snapping/stacking). The public renderer keeps measuring
 * the bare content footprint so its read-time push-down — which compares the
 * measured height against the stored geometry — is byte-unchanged on already
 * published pages whose stored height predates this padding-inclusive commit.
 *
 * Safe to use even when there is no surrounding provider (reflow is null): the
 * effects simply no-op.
 */
export function useReportReflowHeight(blockId, extraHeight = 0) {
  const reflow = useAccordionReflow();
  const containerRef = useRef(null);

  // Active editor zoom, kept in a ref updated every render so the measurement
  // closures below always read the CURRENT zoom without re-binding their
  // ResizeObserver (a pure zoom change must not itself trigger a re-report /
  // bake). Defaults to 1 on the public path, where measurements are unchanged.
  const zoomRef = useRef(1);
  zoomRef.current = (reflow && Number.isFinite(reflow.zoom) && reflow.zoom > 0) ? reflow.zoom : 1;

  // Only the editor bakes measured heights into stored geometry and snaps
  // against them, so the wrapper padding is folded in for the editor only.
  const pad = (reflow?.editorMode && Number.isFinite(extraHeight) && extraHeight > 0)
    ? extraHeight
    : 0;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!reflow || !containerRef.current) return;
    const h = measureReflowHeight(containerRef.current, zoomRef.current);
    if (h > 0) reflow.reportHeight(blockId, Math.round(h + pad));
  }, []); // intentionally mount-only; ResizeObserver below handles ongoing changes

  useEffect(() => {
    if (!reflow || !containerRef.current) return;
    const el = containerRef.current;
    const report = () => {
      const h = measureReflowHeight(el, zoomRef.current);
      if (h > 0) reflow.reportHeight(blockId, Math.round(h + pad));
    };
    // Re-running on `pad` change (author edited padding in the inspector, which
    // does not resize the measured inner element) re-observes and re-reports —
    // ResizeObserver fires an initial callback on observe — so the new padded
    // footprint is picked up immediately.
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reflow, blockId, pad]);

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

  // Active editor zoom (see useReportReflowHeight). Both getBoundingClientRect
  // reads below are inflated by the stage transform, so divide each by zoom to
  // recover the natural content height in true stage coordinates before baking.
  const zoomRef = useRef(1);
  zoomRef.current = (reflow && Number.isFinite(reflow.zoom) && reflow.zoom > 0) ? reflow.zoom : 1;

  const report = useCallback(() => {
    if (!reflow || !outerRef.current) return;
    const z = zoomRef.current;
    const outerH = normalizeMeasuredLength(outerRef.current.getBoundingClientRect().height, z);
    const spacerH = spacerRef.current ? normalizeMeasuredLength(spacerRef.current.getBoundingClientRect().height, z) : 0;
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
 * Natural-bounds reporting for auto-SIZE blocks (Button / CTA — Task #2662).
 *
 * A CTA button renders with `min-width:100%; width:max-content`, so its outer
 * `<a>` element is inflated to fill (at least) the stored block width. Measuring
 * the `<a>` would therefore report the stored width back — the button could grow
 * but never shrink, and the selection box would never tighten around a shorter
 * label. Instead we measure the INNER content span (the real label + icon), then
 * add the anchor's own horizontal/vertical padding + border so the reported
 * bounds equal the width/height the anchor would take at `width:max-content`.
 *
 * The ResizeObserver watches the CONTENT span ONLY (never the min-width-inflated
 * anchor). This is deliberate:
 *   - a label edit changes the content span's size → we re-report (grow OR
 *     shrink, since the span is not min-width constrained), and
 *   - a manual box resize inflates the anchor but NOT the content span, so it
 *     does not fire — the author's manual width/height is preserved until the
 *     next actual content change.
 *
 * `measureKey` re-runs the padding/border re-report when style inputs that
 * change the anchor's padding (variant, size overrides, breakpoint) change
 * without changing the content span's own box.
 *
 * All reporting is gated on editor mode: the public renderer neither measures
 * nor bakes button bounds.
 *
 * Returns { anchorRef, contentRef } to attach to the `<a>` and the inner span.
 */
export function useReportButtonBounds(blockId, measureKey) {
  const reflow = useAccordionReflow();
  const anchorRef = useRef(null);
  const contentRef = useRef(null);

  // Active editor zoom (see useReportReflowHeight). The content span's
  // getBoundingClientRect is inflated by the stage transform, so divide it by
  // zoom. Padding/border read from getComputedStyle are resolved layout-pixel
  // values (NOT transform-scaled), so they are added back un-divided.
  const zoomRef = useRef(1);
  zoomRef.current = (reflow && Number.isFinite(reflow.zoom) && reflow.zoom > 0) ? reflow.zoom : 1;

  const report = useCallback(() => {
    if (!reflow || !reflow.editorMode) return;
    const anchor = anchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;
    const z = zoomRef.current;
    const contentRect = content.getBoundingClientRect();
    let padX = 0;
    let padY = 0;
    try {
      const cs = window.getComputedStyle(anchor);
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pt = parseFloat(cs.paddingTop) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      const blw = parseFloat(cs.borderLeftWidth) || 0;
      const brw = parseFloat(cs.borderRightWidth) || 0;
      const btw = parseFloat(cs.borderTopWidth) || 0;
      const bbw = parseFloat(cs.borderBottomWidth) || 0;
      padX = pl + pr + blw + brw;
      padY = pt + pb + btw + bbw;
    } catch { /* getComputedStyle unavailable — content box only */ }
    const w = normalizeMeasuredLength(contentRect.width, z) + padX;
    const h = normalizeMeasuredLength(contentRect.height, z) + padY;
    if (w > 0 || h > 0) reflow.reportSize(blockId, { w, h });
  }, [reflow, blockId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { report(); }, []); // mount-only; observer + measureKey handle the rest

  useEffect(() => {
    if (!reflow || !reflow.editorMode) return;
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(report);
    observer.observe(el); // CONTENT span only — see hook doc
    return () => observer.disconnect();
  }, [reflow, report]);

  // Re-report when padding-affecting style inputs change without resizing the
  // content span (variant / size overrides / breakpoint), so the baked bounds
  // track the anchor's new padding.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { report(); }, [measureKey]);

  return { anchorRef, contentRef };
}

/**
 * Tracks the measured (rendered) heights of auto-height blocks (accordion)
 * and computes cumulative downward offsets for blocks positioned below them.
 *
 * Props:
 *   blocks      – the flat list of canvas blocks being rendered
 *   resolveGeom – (block) => { x, y, w, h, hidden }  (breakpoint-resolved)
 */
export function AccordionReflowProvider({ children, blocks, resolveGeom, editorMode = false, breakpoint, zoom = 1, onMeasure, onMeasureSize }) {
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

  // Font-load baseline guard (task: phantom gap on hard refresh). On a hard
  // refresh the mount useLayoutEffect measures text in a FALLBACK font (web
  // fonts still loading); if the fallback renders shorter, min-only baseline
  // capture would lock that transient height in forever and the real font's
  // taller render would read as positive growth, pushing every block below
  // down — a phantom gap the builder / SPA navigation never shows. Until web
  // fonts settle, reports are treated as PROVISIONAL (baseline tracks the
  // LATEST measurement — see updateReflowBaseline); min-only semantics start
  // only once fonts are ready. Settling waits for `document.fonts.ready` plus
  // a double rAF so the font-swap ResizeObserver re-report has flushed first
  // (same contract as the editor's settle gate in useAutoHeightBake), with a
  // hard timeout so the gate always opens even if fonts.ready never resolves.
  // Pages using only system fonts settle within a couple of frames, so their
  // behaviour is effectively unchanged.
  const fontsSettledRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const markSettled = () => {
      if (cancelled) return;
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!cancelled) fontsSettledRef.current = true;
        }));
      } else {
        fontsSettledRef.current = true;
      }
    };
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(markSettled).catch(markSettled);
    } else {
      markSettled();
    }
    const t = setTimeout(markSettled, 4000);
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  // Optional editor hook: whenever an auto-height block reports a rendered
  // height we forward it so the editor can commit that height into the block's
  // stored geometry (published render passes no onMeasure, so it stays a pure
  // read-time reflow). Held in a ref so reportHeight keeps a stable identity
  // and the measurement effects don't re-bind when onMeasure changes.
  const onMeasureRef = useRef(onMeasure);
  useEffect(() => { onMeasureRef.current = onMeasure; }, [onMeasure]);

  // Optional editor hook for auto-SIZE blocks (Button / CTA): forwards the
  // block's measured natural width AND height so the editor can bake them into
  // stored per-breakpoint geometry. Unlike reportHeight, this NEVER touches the
  // reflow measuredHeights / rowGroups state — a button's width isn't part of
  // the vertical reflow, and its (small) height change is committed through the
  // same auto-size bake rather than the read-time push-down. Public render
  // passes no onMeasureSize, so it stays inert there.
  const onMeasureSizeRef = useRef(onMeasureSize);
  useEffect(() => { onMeasureSizeRef.current = onMeasureSize; }, [onMeasureSize]);

  const reportSize = useCallback((blockId, size) => {
    if (!onMeasureSizeRef.current) return;
    if (!size) return;
    const w = Math.round(size.w);
    const h = Math.round(size.h);
    onMeasureSizeRef.current(blockId, {
      w: Number.isFinite(w) ? w : NaN,
      h: Number.isFinite(h) ? h : NaN,
    });
  }, []);

  const reportHeight = useCallback((blockId, height) => {
    const rounded = Math.round(height);
    // Provisional (overwrite) before fonts settle, min-only after — see
    // updateReflowBaseline for the phantom-gap rationale.
    updateReflowBaseline(baselineHeightsRef.current, blockId, rounded, fontsSettledRef.current);
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
      const isCard = !!def?.autoHeight && !!def?.cardGrow;
      const useBaseline = !!def?.autoHeight && !def?.cardGrow && Number.isFinite(baseline);
      // Cards (Task #3468): the editor renders a card at height:auto with the
      // stored/manual height only as a min-height floor, so the builder's
      // VISIBLE bottom — which the author sized the section and blocks below
      // around — is max(stored, natural content). Measure public growth from
      // that same reference (max(stored h, collapsed baseline)) so a card row
      // whose content already fit the authored layout contributes zero growth
      // and zero push-down, while content that genuinely grows after the first
      // settled paint still pushes down. Row equalization (effectiveH) is
      // untouched.
      const referenceH = isCard
        ? computeCardReferenceHeight(g.h, baseline)
        : (useBaseline ? Math.min(baseline, g.h) : g.h);
      // Aspect-height Hero Carousels (Task #2824) reflow SIGNED: their
      // rendered height tracks the slide image's aspect ratio at the live
      // viewport width, so blocks below must be pulled UP when the carousel
      // renders shorter than its stored geometry as well as pushed down when
      // taller. Only rows composed entirely of such blocks get signed growth;
      // every other row keeps the push-down-only clamp so author-intended
      // gaps are never collapsed (see the growth comment below).
      const signed = isAspectHeightCarousel(block);
      // Task #2840: for aspect carousels the stored box height is only a
      // snapshot — the editor stage renders them at the aspect-derived height
      // (height:auto + aspect-ratio), and authors align blocks below with that
      // VISIBLE bottom. Measure signed growth from the aspect-derived height
      // at this breakpoint's stage width instead of the stale stored h, so the
      // stored-vs-rendered mismatch is not double-counted as a constant gap
      // (or overlap) below the carousel on every viewport. Legacy blocks with
      // no persisted ratio return null and keep the stored-height reference.
      const aspectRefH = signed
        ? resolveAspectReflowReferenceHeight(block, g, breakpoint)
        : null;
      const finalReferenceH = Number.isFinite(aspectRefH) ? aspectRefH : referenceH;
      entries.push({
        id,
        top: g.y,
        bottom: g.y + g.h,
        refBottom: g.y + finalReferenceH,
        left: g.x,
        right: g.x + g.w,
        fullWidth: blockIsFullWidthLike(block),
        effectiveH,
        signed,
        isCard,
      });
    }
    return buildReflowRowGroups(entries);
  }, [measuredHeights, blocks, resolveGeom, breakpoint]);

  // Non-auto-height content can relay a collision after it has been displaced.
  // Containers are backgrounds, not content obstacles; measured auto-height
  // blocks already contribute their live bottoms through rowGroups.
  const collisionTargets = useMemo(() => {
    const targets = [];
    for (const block of blocks) {
      const def = getBlockDefinition(block.type);
      if (
        def?.autoHeight ||
        block.type === BLOCK_TYPES.SECTION ||
        block.type === BLOCK_TYPES.BOX
      ) {
        continue;
      }
      const geom = resolveGeom(block);
      if (!geom || geom.hidden) continue;
      targets.push({
        ...geom,
        id: block.id,
        top: geom.y,
        bottom: geom.y + geom.h,
        left: geom.x,
        right: geom.x + geom.w,
        fullWidth: blockIsFullWidthLike(block),
      });
    }
    return targets;
  }, [blocks, resolveGeom]);

  /**
   * Returns the live offset (px) for a block at its stored geometry.
   *
   * A source row pushes a target block down when the row's REFERENCE bottom
   * (`refBottom` — the point from which its growth is measured) sits at or above
   * storedY AND their horizontal bounds overlap. This MUST use the same
   * reference the growth is measured from, not
   * the stored box bottom: an accordion's stored box is frequently far taller
   * than its collapsed state, and blocks authored to sit just under the
   * collapsed accordion land in the band [refBottom, bottom). Testing against
   * the stored `bottom` would skip exactly those blocks, so the expanding
   * accordion would grow straight through and overlap them. Testing against
   * `refBottom` pushes them down as intended.
   *
   * Side-by-side sources contribute the largest relevant displacement rather
   * than adding together; vertically stacked sources in the same lane remain
   * cumulative. Signed aspect-carousel rows retain their existing exception.
   */
  const getOffset = useCallback(
    (blockId, storedY) => {
      // Editor mode disables all push-down displacement: blocks render at their
      // stored positions so dragging/dropping never shifts unrelated blocks.
      if (editorMode) return 0;
      if (rowGroups.length === 0) return 0;
      const block = blocks.find((entry) => entry.id === blockId);
      const geom = block ? resolveGeom(block) : null;
      return offsetForTargetGeom(rowGroups, {
        ...(geom || {}),
        y: storedY,
        fullWidth: blockIsFullWidthLike(block),
      }, collisionTargets);
    },
    [editorMode, rowGroups, blocks, resolveGeom, collisionTargets],
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

  /** Deepest cumulative reflow path across the whole stage. */
  const getTotalGrowth = useCallback(() => {
    // Editor mode: stage height derives from stored geometry only.
    if (editorMode) return 0;
    return offsetForTargetGeom(
      rowGroups,
      { y: Infinity, fullWidth: true },
      collisionTargets,
    );
  }, [editorMode, rowGroups, collisionTargets]);

  /**
   * Height growth (px) required by a CONTAINING background-style block — a
   * Section, a decorative Box, or any future shape that wraps other blocks.
   * Ordinary content consumes the container's authored bottom inset before it
   * can grow the container. A block is "inside" the container when its
   * stored top ≥ container.y AND its stored bottom ≤ container.y + container.h.
   *
   * Sections and Boxes compare their final rendered bottom with every contained
   * block's final rendered bottom. This includes static blocks displaced by an
   * upstream accordion. Boxes remain grow-only and continue to exclude card-row
   * equalisation; signed aspect carousels retain their existing section delta.
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
      const spatialContainerGeom = {
        ...containerGeom,
        fullWidth: blockIsFullWidthLike(containerBlock),
      };
      const isBox = containerBlock?.type === BLOCK_TYPES.BOX;
      const containedTargets = [];
      for (const block of blocks) {
        if (!block || block.id === containerBlock?.id) continue;
        const geom = resolveGeom(block);
        if (!geom || geom.hidden) continue;
        const def = getBlockDefinition(block.type);
        // Preserve the existing decorative-Box exception: equalized card rows
        // never resize a Box drawn behind them.
        if (isBox && def?.autoHeight && def?.cardGrow) continue;
        const target = {
          ...geom,
          id: block.id,
          top: geom.y,
          bottom: geom.y + geom.h,
          left: geom.x,
          right: geom.x + geom.w,
          fullWidth: blockIsFullWidthLike(block),
        };
        if (reflowMemberIsContained(spatialContainerGeom, target)) {
          containedTargets.push(target);
        }
      }
      // Containers follow final contained visible bottoms: stacked collisions
      // propagate, parallel lanes contribute their deepest path, and authored
      // room beneath content is consumed before the background grows.
      return growthForContainedGeom(rowGroups, spatialContainerGeom, containedTargets, {
        growOnly: isBox,
        relayTargets: collisionTargets,
      });
    },
    [editorMode, rowGroups, blocks, resolveGeom, collisionTargets],
  );

  // Back-compat alias: sections are just one kind of container.
  const getSectionGrowth = getContainerGrowth;

  const getStageHeight = useCallback(
    (baseHeight) => computeReflowStageHeight({
      baseHeight,
      blocks,
      resolveGeom,
      rowGroups,
      editorMode,
      getContainerGrowth,
      relayTargets: collisionTargets,
    }),
    [blocks, resolveGeom, rowGroups, editorMode, getContainerGrowth, collisionTargets],
  );

  return (
    <AccordionReflowCtx.Provider value={{ editorMode, zoom, reportHeight, reportSize, getOffset, getMeasuredHeight, getContentHeight, getRowHeight, getTotalGrowth, getStageHeight, getSectionGrowth, getContainerGrowth }}>
      {children}
    </AccordionReflowCtx.Provider>
  );
}
