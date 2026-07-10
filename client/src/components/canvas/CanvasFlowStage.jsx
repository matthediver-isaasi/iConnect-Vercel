import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolveBlockAtBreakpoint,
  isFlowContainerType,
  getSectionLandmarkTag,
  blockSupportsFullBleed,
  resolveBlockHeightCss,
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

function tagForNode(node) {
  const landmark = getSectionLandmarkTag(node?.type, node?.a11y?.role);
  if (landmark) return landmark;
  if (node?.type === BLOCK_TYPES.SECTION) return "section";
  return "div";
}

// Collect every node that the engine produced a box for, in DFS order (parents
// first so they paint behind children). Hidden nodes get no box, so they are
// naturally excluded here.
function collectPlacedNodes(design, boxes) {
  const out = [];
  forEachFlowNode(design, (node, { depth }) => {
    if (boxes[node.id]) out.push({ node, depth });
  });
  return out;
}

function FlowNode({ node, box, breakpoint, isAuto, isPriority, registerRef }) {
  const def = getBlockDefinition(node.type);
  const Renderer = def?.Renderer;
  const isContainer = isFlowContainerType(node.type);
  const { style = {}, a11y = {} } = node;
  const Tag = tagForNode(node);

  const usedLandmark = getSectionLandmarkTag(node?.type, a11y?.role);
  const explicitRole = a11y?.role && !usedLandmark ? a11y.role : undefined;

  // Auto-height leaves size to their content (measured back into the engine);
  // everything else uses the engine-resolved height.
  const heightOverride = !isContainer ? resolveBlockHeightCss(node) : null;
  const height = isAuto ? "auto" : (heightOverride || box.h);

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
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height,
        background: style.background,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        opacity: style.opacity,
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
      tabIndex={typeof a11y?.tabIndex === "number" ? a11y.tabIndex : undefined}
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

export default function CanvasFlowStage({ design, forceBreakpoint, lcpBlockId }) {
  const stageRef = useRef(null);
  const nodeRefs = useRef({});
  const [measured, setMeasured] = useState({});
  // SSR / first-paint container width falls back to the desktop stage width so
  // the initial HTML lays out correctly before measurement kicks in.
  const [containerWidth, setContainerWidth] = useState(
    forceBreakpoint ? BREAKPOINT_WIDTHS[forceBreakpoint] : BREAKPOINT_WIDTHS.desktop
  );

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

  const placed = useMemo(() => collectPlacedNodes(design, boxes), [design, boxes]);

  const autoLeafIds = useMemo(
    () =>
      placed
        .filter(
          ({ node }) =>
            AUTO_HEIGHT_LEAF_TYPES.has(node.type) &&
            (node.flow?.heightMode || "auto") !== "fixed"
        )
        .map(({ node }) => node.id),
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
          if (!Number.isFinite(h) || h <= 0) continue;
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
  }, [autoLeafIds.join("|"), containerWidth, breakpoint, design]);

  const forcedWidthStyle = forceBreakpoint
    ? {
        width: BREAKPOINT_WIDTHS[forceBreakpoint],
        maxWidth: BREAKPOINT_WIDTHS[forceBreakpoint],
      }
    : { maxWidth: BREAKPOINT_WIDTHS.desktop };

  return (
    <main
      id="canvas-main-content"
      ref={stageRef}
      tabIndex={-1}
      className="canvas-stage focus:outline-none"
      style={{
        position: "relative",
        width: "100%",
        margin: "0 auto",
        minHeight: height,
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
            registerRef={(el) => {
              if (el) nodeRefs.current[node.id] = el;
              else delete nodeRefs.current[node.id];
            }}
          />
        );
      })}
    </main>
  );
}
