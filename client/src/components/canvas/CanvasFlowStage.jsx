import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolveBlockAtBreakpoint,
  isFlowContainerType,
  getSectionLandmarkTag,
  blockSupportsFullBleed,
  resolveBlockHeightCss,
  resolveBoxShadowCss,
  forEachFlowNode,
  AUTO_HEIGHT_LEAF_TYPES,
  BLOCK_TYPES,
  BREAKPOINT_WIDTHS,
} from "@/lib/canvasDesign";
import { resolveFlowLayout } from "@/lib/canvasFlowLayout";
import { getBlockDefinition } from "./blocks/registry";

// Task #2570 — Published (public) renderer for v2 flow (auto-layout) Canvas
// pages. It drives layout off the SINGLE shared engine (resolveFlowLayout) so
// the live page can never drift from the builder: every node's absolute
// {x,y,w,h} box comes from the engine, given the real container width and the
// measured heights of content-driven (auto-height) leaves.
//
// Rendering model (mirrors the flat v1 renderer): every node — containers AND
// leaves — is an absolutely-positioned sibling inside one relative stage.
// Containers paint their own background/border behind their descendants (DFS
// order guarantees a parent paints before its children), leaves paint content.
// The engine's boxes are absolute to the page origin, so this flat placement
// reproduces the tree layout exactly.

const BP_MOBILE_MAX = 640;
const BP_TABLET_MAX = 1024;

function breakpointForWidth(width) {
  if (!Number.isFinite(width)) return "desktop";
  if (width < BP_MOBILE_MAX) return "mobile";
  if (width < BP_TABLET_MAX) return "tablet";
  return "desktop";
}

function tagForNode(node, embedded = false) {
  const landmark = embedded ? null : getSectionLandmarkTag(node?.type, node?.a11y?.role);
  if (landmark) return landmark;
  if (node?.type === BLOCK_TYPES.SECTION) return "section";
  return "div";
}

// Collect every node placed at ANY breakpoint, in DFS order (parents first so
// they paint behind children). The three per-breakpoint layouts use the fixed
// representative stage widths and no measured heights — this is exactly what the
// static first-paint stylesheet (buildFlowCanvasCss) is built from, so the
// rendered DOM set matches the nodes that stylesheet can position/reveal. A node
// hidden at one breakpoint but shown at another is included once; per-breakpoint
// visibility is handled by the stylesheet (pre-hydration) and inline
// `display:none` (post-hydration).
function collectUnionPlacedNodes(design) {
  const dl = resolveFlowLayout(design, { breakpoint: "desktop", containerWidth: BREAKPOINT_WIDTHS.desktop });
  const tl = resolveFlowLayout(design, { breakpoint: "tablet", containerWidth: BREAKPOINT_WIDTHS.tablet });
  const ml = resolveFlowLayout(design, { breakpoint: "mobile", containerWidth: BREAKPOINT_WIDTHS.mobile });
  const out = [];
  const seen = new Set();
  forEachFlowNode(design, (node, { depth }) => {
    if (seen.has(node.id)) return;
    if (dl.boxes[node.id] || tl.boxes[node.id] || ml.boxes[node.id]) {
      seen.add(node.id);
      out.push({ node, depth });
    }
  });
  return out;
}

function FlowNode({ node, box, breakpoint, isAuto, isPriority, hydrated, registerRef, embedded = false }) {
  const def = getBlockDefinition(node.type);
  const Renderer = def?.Renderer;
  const isContainer = isFlowContainerType(node.type);
  const { style = {}, a11y = {} } = node;
  const Tag = tagForNode(node, embedded);

  const usedLandmark = embedded ? null : getSectionLandmarkTag(node?.type, a11y?.role);
  const explicitRole = embedded ? undefined : (a11y?.role && !usedLandmark ? a11y.role : undefined);

  // Auto-height leaves size to their content (measured back into the engine);
  // everything else uses the engine-resolved height.
  const heightOverride = !isContainer ? resolveBlockHeightCss(node) : null;

  // Geometry source of truth:
  //  - Before measurement (hydrated=false): the per-page static stylesheet
  //    (buildFlowCanvasCss) positions this node with breakpoint-correct @media
  //    rules, so we emit NO inline geometry and let the stylesheet win. This is
  //    the first paint crawlers / slow connections / no-JS visitors see.
  //  - After measurement (hydrated=true): inline styles from the engine (real
  //    container width + measured heights) take over and override the stylesheet
  //    — the content-accurate final layout, applied in the layout phase before
  //    the browser paints so there is no visible shift.
  let geomStyle;
  if (!hydrated) {
    geomStyle = null;
  } else if (!box) {
    // Hidden at the current measured breakpoint. A wider breakpoint's stylesheet
    // rule may have shown it, so force it hidden inline.
    geomStyle = { display: "none" };
  } else {
    geomStyle = {
      display: "block",
      position: "absolute",
      left: box.x,
      top: box.y,
      width: box.w,
      height: isAuto ? "auto" : (heightOverride || box.h),
    };
  }

  return (
    <Tag
      ref={isAuto ? registerRef : undefined}
      id={node.anchorId || undefined}
      role={explicitRole}
      aria-label={a11y?.ariaLabel || undefined}
      data-cb={node.id}
      data-block-id={node.id}
      data-block-type={node.type}
      data-full-bleed={
        blockSupportsFullBleed(node.type) && node.content?.fullBleed ? "true" : undefined
      }
      style={{
        ...geomStyle,
        background: style.background,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        opacity: style.opacity,
        boxShadow: resolveBoxShadowCss(style),
        zIndex: style.zIndex,
        // absoluteFill leaves consume their own padding internally (see the v1
        // renderer note); skip wrapper padding for them.
        paddingTop: def?.absoluteFill ? 0 : style.paddingTop || 0,
        paddingRight: def?.absoluteFill ? 0 : style.paddingRight || 0,
        paddingBottom: def?.absoluteFill ? 0 : style.paddingBottom || 0,
        paddingLeft: def?.absoluteFill ? 0 : style.paddingLeft || 0,
        boxSizing: "border-box",
        overflow: isContainer || def?.allowOverflow ? "visible" : "hidden",
      }}
      aria-hidden={a11y?.ariaHidden ? true : undefined}
      lang={a11y?.lang || undefined}
    >
      {/* Containers are structural — their children render as siblings in the
          flat stage, so we only render leaf content here. */}
      {!isContainer && Renderer && (
        <Renderer block={node} priority={isPriority} breakpoint={breakpoint} />
      )}
    </Tag>
  );
}

export default function CanvasFlowStage({ design, forceBreakpoint, lcpBlockId, embedded = false }) {
  const stageRef = useRef(null);
  const nodeRefs = useRef({});
  const [measured, setMeasured] = useState({});
  // SSR / first-paint container width falls back to the desktop stage width so
  // the initial HTML lays out correctly before measurement kicks in.
  const [containerWidth, setContainerWidth] = useState(
    forceBreakpoint ? BREAKPOINT_WIDTHS[forceBreakpoint] : BREAKPOINT_WIDTHS.desktop
  );
  // Task #2648 — until the first measurement pass runs, the per-page static
  // stylesheet (buildFlowCanvasCss) drives geometry so the first paint is
  // breakpoint-correct without JS. An embedded/forced-breakpoint preview pins
  // its own width, so it starts hydrated (inline geometry from the start).
  const [hydrated, setHydrated] = useState(!!forceBreakpoint);

  const breakpoint = forceBreakpoint || breakpointForWidth(containerWidth);

  // Measure the real stage width (fluid, capped by the CSS max-width) unless a
  // breakpoint is forced (editor preview), in which case pin it exactly.
  useLayoutEffect(() => {
    if (forceBreakpoint) {
      setContainerWidth(BREAKPOINT_WIDTHS[forceBreakpoint]);
      return;
    }
    if (typeof window === "undefined") return;
    const el = stageRef.current;
    if (!el) return;
    const read = () => {
      const w = el.clientWidth;
      if (Number.isFinite(w) && w > 0) setContainerWidth(w);
    };
    read();
    let ro;
    try {
      ro = new ResizeObserver(read);
      ro.observe(el);
    } catch {
      window.addEventListener("resize", read, { passive: true });
    }
    return () => {
      try {
        if (ro) ro.disconnect();
        else window.removeEventListener("resize", read);
      } catch {}
    };
  }, [forceBreakpoint]);

  const { boxes, height } = useMemo(
    () => resolveFlowLayout(design, { breakpoint, containerWidth, measured }),
    [design, breakpoint, containerWidth, measured]
  );

  // Render the union of nodes placed at any breakpoint so the static stylesheet
  // (which carries @media rules for all three) can position/reveal each one on
  // first paint. Depends only on `design` (fixed representative widths), so it
  // is stable across measurement re-renders.
  const placed = useMemo(() => collectUnionPlacedNodes(design), [design]);

  // Only measure leaves actually placed at the current breakpoint (others are
  // hidden — display:none — and would measure 0).
  const autoLeafIds = useMemo(
    () =>
      placed
        .filter(
          ({ node }) =>
            boxes[node.id] &&
            AUTO_HEIGHT_LEAF_TYPES.has(node.type) &&
            (node.flow?.heightMode || "auto") !== "fixed"
        )
        .map(({ node }) => node.id),
    [placed, boxes]
  );
  const zeroHeightLeafIds = useMemo(
    () => new Set(
      placed
        .filter(({ node }) => node.type === BLOCK_TYPES.CARD_FLIP_GRID)
        .map(({ node }) => node.id)
    ),
    [placed]
  );

  // Measure content-driven leaves and feed their heights back into the engine
  // so siblings below them (and their containers) resolve to the correct Y.
  // A ResizeObserver re-measures on async content settle (fonts, images).
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const measure = () => {
      setMeasured((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of autoLeafIds) {
          const el = nodeRefs.current[id];
          if (!el) continue;
          const h = el.offsetHeight;
          // An empty Card Flip Grid has a legitimate zero-height footprint.
          // Preserve that measurement so removing its final card clears any
          // previously measured height and pulls downstream flow content up.
          if (!Number.isFinite(h) || h < 0 || (h === 0 && !zeroHeightLeafIds.has(id))) continue;
          if (next[id]?.height == null || Math.abs(next[id].height - h) > 1) {
            next[id] = { height: h };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    measure();
    let ro;
    try {
      ro = new ResizeObserver(measure);
      for (const id of autoLeafIds) {
        const el = nodeRefs.current[id];
        if (el) ro.observe(el);
      }
    } catch {}
    return () => {
      try {
        if (ro) ro.disconnect();
      } catch {}
    };
  }, [autoLeafIds.join("|"), zeroHeightLeafIds, containerWidth, breakpoint, design]);

  // Once mounted (after the width + height measurement effects above have run
  // their first pass in this same layout phase), switch from the static
  // first-paint stylesheet to engine-driven inline geometry. Because this runs
  // in the layout phase, the swap completes before the browser paints — JS
  // visitors see only the measured layout (no shift); crawlers / no-JS keep the
  // stylesheet layout.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    setHydrated(true);
  }, []);

  const forcedWidthStyle = forceBreakpoint
    ? {
        width: BREAKPOINT_WIDTHS[forceBreakpoint],
        maxWidth: BREAKPOINT_WIDTHS[forceBreakpoint],
      }
    : { maxWidth: BREAKPOINT_WIDTHS.desktop };

  const StageTag = embedded ? "div" : "main";
  return (
    <StageTag
      id={embedded ? undefined : "canvas-main-content"}
      ref={stageRef}
      tabIndex={embedded ? undefined : -1}
      className="canvas-stage focus:outline-none"
      style={{
        position: "relative",
        width: "100%",
        margin: "0 auto",
        // Pre-hydration the static stylesheet supplies a per-breakpoint
        // min-height (@media); once measured we pin the engine-resolved height.
        ...(hydrated ? { minHeight: height } : null),
        ...forcedWidthStyle,
      }}
      data-testid="canvas-page-stage"
    >
      {placed.map(({ node }) => {
        const box = boxes[node.id];
        const isAuto =
          AUTO_HEIGHT_LEAF_TYPES.has(node.type) &&
          (node.flow?.heightMode || "auto") !== "fixed";
        return (
          <FlowNode
            key={node.id}
            node={node}
            box={box}
            breakpoint={breakpoint}
            isAuto={isAuto}
            isPriority={node.id === lcpBlockId}
            hydrated={hydrated}
            registerRef={(el) => {
              if (el) nodeRefs.current[node.id] = el;
              else delete nodeRefs.current[node.id];
            }}
            embedded={embedded}
          />
        );
      })}
    </StageTag>
  );
}
