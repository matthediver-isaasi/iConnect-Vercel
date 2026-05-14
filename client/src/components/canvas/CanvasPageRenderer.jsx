import React, { useEffect, useMemo, useState } from "react";
import {
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
  getRootChildren,
  buildCanvasCss,
  findLcpBlockId,
  getSectionLandmarkTag,
  BLOCK_TYPES,
} from "@/lib/canvasDesign";
import { getBlockDefinition } from "./blocks/registry";

// Public renderer for Canvas Builder pages.
//
// Layout is driven by a per-page <style> stylesheet emitted up-front, so
// the browser positions blocks correctly on first paint without any JS.
// This is essential for SSR / prerender output, Lighthouse LCP/CLS, and
// users with JS disabled or throttled. The editor preview iframe can
// still force a breakpoint via `?_bp=` for the desktop/tablet/mobile
// preview chips; in that mode we override the layout client-side.

function useForcedBreakpoint() {
  const get = () => {
    if (typeof window === 'undefined') return null;
    try {
      const params = new URLSearchParams(window.location.search);
      const forced = params.get('_bp');
      if (forced === 'desktop' || forced === 'tablet' || forced === 'mobile') return forced;
    } catch {}
    return null;
  };
  const [bp, setBp] = useState(get);
  useEffect(() => {
    setBp(get());
  }, []);
  return bp;
}

function tagForBlock(block) {
  // Landmark elements are only emitted for section-type blocks — this
  // prevents invalid HTML and nested-<main> landmarks when a non-section
  // block (image, button, text…) is mis-assigned a landmark role. The
  // <main> landmark is never emitted at block level: the stage wrapper
  // already owns the top-level <main>.
  const landmark = getSectionLandmarkTag(block?.type, block?.a11y?.role);
  if (landmark) return landmark;
  if (block?.type === BLOCK_TYPES.SECTION) return 'section';
  return 'div';
}

function CanvasBlockRender({ block, lcpBlockId, forcedBreakpoint }) {
  const def = getBlockDefinition(block.type);
  const Renderer = def?.Renderer;
  const { style, a11y } = block;
  const Tag = tagForBlock(block);
  const isSection = block.type === BLOCK_TYPES.SECTION;
  const isPriority = block.id === lcpBlockId;

  // When the editor forces a breakpoint via `?_bp=`, resolve geometry in
  // JS and pin it inline so the static stylesheet is overridden.
  let forcedStyle = null;
  if (forcedBreakpoint) {
    const g = resolveBlockAtBreakpoint(block, forcedBreakpoint);
    if (g.hidden) return null;
    const fullBleed = isSection && !!(block.content && block.content.fullBleed);
    forcedStyle = fullBleed
      ? { position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: '100vw', top: g.y, height: g.h }
      : { position: 'absolute', left: g.x, top: g.y, width: g.w, height: g.h };
  }

  // If we upgraded the wrapper to a semantic landmark tag, drop the
  // redundant role attribute. Otherwise carry the role through as an
  // attribute so screen readers still receive the author's intent.
  const usedLandmark = getSectionLandmarkTag(block?.type, a11y?.role);
  const explicitRole = a11y?.role && !usedLandmark ? a11y.role : undefined;

  return (
    <Tag
      role={explicitRole}
      aria-label={a11y?.ariaLabel || undefined}
      data-cb={block.id}
      data-block-type={block.type}
      data-full-bleed={isSection && block.content?.fullBleed ? 'true' : undefined}
      style={{
        ...(forcedStyle || null),
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
        overflow: isSection ? 'visible' : 'hidden',
      }}
      tabIndex={typeof a11y?.tabIndex === 'number' ? a11y.tabIndex : undefined}
      aria-hidden={a11y?.ariaHidden ? true : undefined}
    >
      {Renderer && <Renderer block={block} priority={isPriority} breakpoint={forcedBreakpoint || undefined} />}
    </Tag>
  );
}

export default function CanvasPageRenderer({ page }) {
  const design = useMemo(() => normalizeCanvasDesign(page?.canvas_design), [page?.canvas_design]);
  const children = useMemo(() => getRootChildren(design), [design]);
  const hasBlocks = children.length > 0;

  // Stable scope id so the per-page CSS only affects this page's stage.
  const scopeId = useMemo(
    () => `cb-${page?.id || page?.slug || Math.random().toString(36).slice(2, 8)}`,
    [page?.id, page?.slug],
  );
  const css = useMemo(
    () => (hasBlocks ? buildCanvasCss(children, `#${scopeId}`) : ''),
    [children, hasBlocks, scopeId],
  );
  const lcpBlockId = useMemo(() => (hasBlocks ? findLcpBlockId(children) : null), [children, hasBlocks]);

  const forcedBreakpoint = useForcedBreakpoint();

  if (!hasBlocks) {
    return (
      <div className="w-full" data-testid={`canvas-page-${page?.slug || ''}`}>
        <div className="min-h-[40vh] flex items-center justify-center" data-testid="canvas-page-empty">
          <div className="text-center px-6">
            <p className="text-slate-600">
              This page is currently being built. Please check back soon.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      id={scopeId}
      className="canvas-page w-full"
      data-testid={`canvas-page-${page?.slug || ''}`}
      data-canvas-version={design.version}
    >
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {/*
        The stage wrapper is intentionally a non-landmark <div> so that:
        (a) the host shell can own the page's single top-level <main>, and
        (b) block-level section landmarks (header/nav/aside/footer) are
        never nested inside a redundant <main>.
      */}
      <div className="canvas-stage" data-testid="canvas-page-stage">
        {children.map((b) => (
          <CanvasBlockRender
            key={b.id}
            block={b}
            lcpBlockId={lcpBlockId}
            forcedBreakpoint={forcedBreakpoint}
          />
        ))}
      </div>
    </div>
  );
}
