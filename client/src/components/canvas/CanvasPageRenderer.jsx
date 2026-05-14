import React, { useEffect, useState } from "react";
import {
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
  getRootChildren,
  BREAKPOINT_WIDTHS,
} from "@/lib/canvasDesign";
import { getBlockDefinition } from "./blocks/registry";

// Phase 2 public renderer for Canvas Builder pages.
//
// Renders absolutely-positioned blocks on a fluid stage. Blocks have
// per-breakpoint geometry; we resolve the active breakpoint from window
// width (or a forced ?_bp= query for the in-editor preview iframe).
function useActiveBreakpoint() {
  const getBp = () => {
    if (typeof window === 'undefined') return 'desktop';
    try {
      const params = new URLSearchParams(window.location.search);
      const forced = params.get('_bp');
      if (forced === 'desktop' || forced === 'tablet' || forced === 'mobile') return forced;
    } catch {}
    const w = window.innerWidth;
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  };
  const [bp, setBp] = useState(getBp);
  useEffect(() => {
    const handler = () => setBp(getBp());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return bp;
}

function CanvasBlockRender({ block, breakpoint }) {
  const geom = resolveBlockAtBreakpoint(block, breakpoint);
  if (geom.hidden) return null;
  const { style, a11y } = block;
  const def = getBlockDefinition(block.type);
  const Renderer = def.Renderer;

  const isSection = block.type === 'section';
  const isFullBleed = isSection && !!(block.content && block.content.fullBleed);

  // Full-bleed sections escape the centered, max-width stage by anchoring
  // to the stage's horizontal center (which equals the viewport center
  // because the stage is `justify-center`-flexed) and stretching to the
  // full viewport width. Their vertical position/height still comes from
  // the design geometry so authors can compose them with other blocks.
  const positionStyle = isFullBleed
    ? {
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '100vw',
        top: geom.y,
        height: geom.h,
      }
    : {
        position: 'absolute',
        left: geom.x,
        top: geom.y,
        width: geom.w,
        height: geom.h,
      };

  return (
    <div
      role={a11y?.role || undefined}
      aria-label={a11y?.ariaLabel || undefined}
      data-block-id={block.id}
      data-block-type={block.type}
      data-full-bleed={isFullBleed ? 'true' : undefined}
      style={{
        ...positionStyle,
        background: style.background,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        borderRadius: style.borderRadius,
        opacity: style.opacity,
        zIndex: style.zIndex,
        paddingTop: style.paddingTop || 0,
        paddingRight: style.paddingRight || 0,
        paddingBottom: style.paddingBottom || 0,
        paddingLeft: style.paddingLeft || 0,
        boxSizing: 'border-box',
        // Sections never clip; everything else does so absolute-positioned
        // children can't overflow each other unexpectedly.
        overflow: isSection ? 'visible' : 'hidden',
      }}
      tabIndex={typeof a11y?.tabIndex === 'number' ? a11y.tabIndex : undefined}
      aria-hidden={a11y?.ariaHidden ? true : undefined}
    >
      {Renderer && <Renderer block={block} breakpoint={breakpoint} />}
    </div>
  );
}

export default function CanvasPageRenderer({ page }) {
  const design = normalizeCanvasDesign(page?.canvas_design);
  const children = getRootChildren(design);
  const hasBlocks = children.length > 0;
  const breakpoint = useActiveBreakpoint();
  const canvasWidth = BREAKPOINT_WIDTHS[breakpoint] || BREAKPOINT_WIDTHS.desktop;

  // Compute stage height as max(bottom) across visible blocks, plus padding.
  let stageHeight = 600;
  for (const b of children) {
    const g = resolveBlockAtBreakpoint(b, breakpoint);
    if (g.hidden) continue;
    stageHeight = Math.max(stageHeight, g.y + g.h + 80);
  }

  return (
    <div
      className="w-full"
      data-testid={`canvas-page-${page?.slug || ''}`}
      data-canvas-version={design.version}
      data-breakpoint={breakpoint}
    >
      {!hasBlocks ? (
        <div
          className="min-h-[40vh] flex items-center justify-center"
          data-testid="canvas-page-empty"
        >
          <div className="text-center px-6">
            <p className="text-slate-600">
              This page is currently being built. Please check back soon.
            </p>
          </div>
        </div>
      ) : (
        <div className="w-full flex justify-center">
          <div
            className="relative"
            style={{
              width: '100%',
              maxWidth: canvasWidth,
              height: stageHeight,
            }}
            data-testid="canvas-page-stage"
          >
            {children.map((b) => (
              <CanvasBlockRender key={b.id} block={b} breakpoint={breakpoint} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
