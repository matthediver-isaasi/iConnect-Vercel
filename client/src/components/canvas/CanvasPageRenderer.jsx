import React, { useEffect, useMemo, useState } from "react";
import {
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
  getRootChildren,
  buildCanvasCss,
  findLcpBlockId,
  getSectionLandmarkTag,
  resolveSymbolsInDesign,
  buildThemeCssVars,
  BLOCK_TYPES,
} from "@/lib/canvasDesign";
import { getBlockDefinition } from "./blocks/registry";

// Phase 7 — Hooks that fetch the tenant Canvas theme and any referenced
// symbols. Both are best-effort; failures degrade to "no theme" and
// "symbol placeholder" respectively so a missing endpoint never blocks
// rendering.
function useTenantCanvasTheme() {
  const [theme, setTheme] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/tenant-canvas-theme', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!cancelled && body) setTheme(body.theme || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return theme;
}

function useSymbolsForDesign(design) {
  const symbolIds = useMemo(() => {
    const ids = new Set();
    try {
      for (const section of design?.root?.sections || []) {
        for (const b of section.children || []) {
          if (b.type === BLOCK_TYPES.SYMBOL && b?.content?.symbolId) ids.add(b.content.symbolId);
        }
      }
    } catch {}
    return Array.from(ids);
  }, [design]);
  const [byId, setById] = useState(() => new Map());
  useEffect(() => {
    if (symbolIds.length === 0) { setById(new Map()); return; }
    let cancelled = false;
    // Public read endpoint resolves tenant by host, so anonymous
    // visitors can still see resolved symbol content.
    fetch('/api/public/canvas-symbols', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const m = new Map();
        for (const s of body.symbols || []) m.set(s.id, s);
        setById(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [symbolIds.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return byId;
}

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
    const fullWidth = !!block.fullWidth;
    if (fullBleed) {
      forcedStyle = { position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: '100vw', top: g.y, height: g.h };
    } else if (fullWidth) {
      forcedStyle = { position: 'absolute', left: 0, top: g.y, width: '100%', height: g.h };
    } else {
      forcedStyle = { position: 'absolute', left: g.x, top: g.y, width: g.w, height: g.h };
    }
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
      data-block-id={block.id}
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
      lang={a11y?.lang || undefined}
    >
      {Renderer && <Renderer block={block} priority={isPriority} breakpoint={forcedBreakpoint || undefined} />}
    </Tag>
  );
}

// Default a11y stylesheet for Canvas pages:
// - honours prefers-reduced-motion by killing transitions/animations on
//   canvas-rendered blocks
// - gives every focusable descendant a visible focus ring so keyboard
//   users always know where they are
const A11Y_DEFAULTS_CSS = `
  [data-canvas-version] :focus-visible {
    outline: 2px solid hsl(var(--primary, 222 47% 31%));
    outline-offset: 2px;
    border-radius: 4px;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-canvas-version] *,
    [data-canvas-version] *::before,
    [data-canvas-version] *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
      scroll-behavior: auto !important;
    }
  }
`;

export default function CanvasPageRenderer({ page }) {
  const baseDesign = useMemo(() => normalizeCanvasDesign(page?.canvas_design), [page?.canvas_design]);
  const symbolsById = useSymbolsForDesign(baseDesign);
  const theme = useTenantCanvasTheme();
  const design = useMemo(
    () => resolveSymbolsInDesign(baseDesign, symbolsById) || baseDesign,
    [baseDesign, symbolsById],
  );
  // Splice symbol children into the flat block list so the CSS layout
  // generator picks them up. Symbols themselves render as transparent
  // wrappers; their children take over geometry.
  const children = useMemo(() => {
    const root = getRootChildren(design);
    const out = [];
    for (const b of root) {
      if (b.type === BLOCK_TYPES.SYMBOL && Array.isArray(b.__symbolChildren)) {
        out.push(...b.__symbolChildren);
      } else {
        out.push(b);
      }
    }
    return out;
  }, [design]);
  const hasBlocks = children.length > 0;
  const themeCss = useMemo(() => buildThemeCssVars(theme), [theme]);

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
      <div
        className="w-full"
        data-testid={`canvas-page-${page?.slug || ''}`}
        data-canvas-version={design.version}
      >
        <a
          href="#canvas-main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:px-3 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:shadow-md"
          data-testid="link-skip-to-content"
        >
          Skip to content
        </a>
        <style>{A11Y_DEFAULTS_CSS}</style>
        <main
          id="canvas-main-content"
          tabIndex={-1}
          className="min-h-[40vh] flex items-center justify-center focus:outline-none"
          data-testid="canvas-page-empty"
        >
          <div className="text-center px-6">
            <p className="text-slate-600">
              This page is currently being built. Please check back soon.
            </p>
          </div>
        </main>
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
      {/* Skip-to-content link — visually hidden until focused. */}
      <a
        href="#canvas-main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:px-3 focus:py-2 focus:rounded-md focus:bg-primary focus:text-primary-foreground focus:shadow-md"
        data-testid="link-skip-to-content"
      >
        Skip to content
      </a>
      <style>{A11Y_DEFAULTS_CSS}</style>
      {themeCss && (
        <style dangerouslySetInnerHTML={{ __html: `#${scopeId}{${themeCss}}` }} />
      )}
      <style dangerouslySetInnerHTML={{ __html: css }} />
      {/*
        The stage wrapper is intentionally a non-landmark <div> so that:
        (a) the host shell can own the page's single top-level <main>, and
        (b) block-level section landmarks (header/nav/aside/footer) are
        never nested inside a redundant <main>.
        We promote the inner stage to <main id="canvas-main-content"> so the
        skip-to-content link has a valid target.
      */}
      <main
        id="canvas-main-content"
        tabIndex={-1}
        className="canvas-stage focus:outline-none"
        data-testid="canvas-page-stage"
      >
        {children.map((b) => (
          <CanvasBlockRender
            key={b.id}
            block={b}
            lcpBlockId={lcpBlockId}
            forcedBreakpoint={forcedBreakpoint}
          />
        ))}
      </main>
    </div>
  );
}
