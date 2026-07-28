import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  normalizeCanvasDesign,
  resolveBlockAtBreakpoint,
  buildCanvasCss,
  findLcpBlockId,
  getSectionLandmarkTag,
  resolveSymbolsInDesign,
  buildThemeCssVars,
  stageHeightForBreakpoint,
  clampGeomToStage,
  BLOCK_TYPES,
  BREAKPOINT_WIDTHS,
  blockSupportsFullBleed,
  getBlockBleed,
  resolveBleedBorderRadius,
  resolveBlockHeightCss,
  resolveAspectSizingStyle,
  resolveBoxShadowCss,
  resolveWrapperBackground,
  isFlowDesign,
} from "@/lib/canvasDesign";
import { buildFlowCanvasCss } from "@/lib/canvasFlowLayout";
import { getBlockDefinition } from "./blocks/registry";
import { AccordionReflowProvider, useAccordionReflow } from "./AccordionReflowContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import CanvasFlowStage from "./CanvasFlowStage";

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

function useSymbolsForDesign(design, providedSymbols) {
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
  // Symbols delivered with the page payload are authoritative and always fresh
  // (scoped to this exact published page, never edge-cached). Build the map
  // from them first so the renderer has everything it needs without a second
  // request — this is what prevents the grey placeholder on published pages.
  const providedById = useMemo(() => {
    const m = new Map();
    if (Array.isArray(providedSymbols)) {
      for (const s of providedSymbols) { if (s?.id) m.set(s.id, s); }
    }
    return m;
  }, [providedSymbols]);
  // Only fall back to the standalone endpoint for symbol ids the page payload
  // did not cover (e.g. the authenticated/base44 fetch path that has no
  // embedded symbols).
  const missingIds = useMemo(
    () => symbolIds.filter((id) => !providedById.has(id)),
    [symbolIds, providedById],
  );
  const [fetchedById, setFetchedById] = useState(() => new Map());
  useEffect(() => {
    if (missingIds.length === 0) { setFetchedById(new Map()); return; }
    let cancelled = false;
    // Public read endpoint resolves tenant by host, so anonymous
    // visitors can still see resolved symbol content.
    fetch('/api/public/canvas-symbols', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const m = new Map();
        for (const s of body.symbols || []) m.set(s.id, s);
        setFetchedById(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [missingIds.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (fetchedById.size === 0) return providedById;
    const m = new Map(fetchedById);
    // Provided (page-scoped) symbols win over the cached fallback.
    for (const [id, s] of providedById) m.set(id, s);
    return m;
  }, [providedById, fetchedById]);
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

// Detect the active CSS breakpoint from window width so that the reflow
// context can resolve geometry correctly in non-forced-breakpoint mode.
function useWindowBreakpoint() {
  const get = () => {
    if (typeof window === 'undefined') return 'desktop';
    const w = window.innerWidth;
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  };
  const [bp, setBp] = useState(get);
  useEffect(() => {
    const handler = () => setBp(get());
    window.addEventListener('resize', handler, { passive: true });
    return () => window.removeEventListener('resize', handler);
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

function CanvasBlockRender({ block, lcpBlockId, forcedBreakpoint, windowBp, pinStageWidth }) {
  const def = getBlockDefinition(block.type);
  const Renderer = def?.Renderer;
  const { style, a11y } = block;
  const Tag = tagForBlock(block);
  const isSection = block.type === BLOCK_TYPES.SECTION;
  // Box (and future background-style shapes) behave like a section for growth:
  // when a block sitting on top of them grows taller, the background grows to
  // stay wrapped around it. They are NOT auto-height (their box height is
  // author-set), so growth is applied on top of the stored height.
  const isBox = block.type === BLOCK_TYPES.BOX;
  const isContainerBg = isSection || isBox;
  const isPriority = block.id === lcpBlockId;
  const isAutoHeight = !!def?.autoHeight;

  // Reflow: compute how far down this block should be pushed by accordions above it.
  const reflow = useAccordionReflow();
  // Resolve the stored geometry for the active breakpoint so we know storedY.
  const activeBp = forcedBreakpoint || windowBp || 'desktop';
  const storedGeom = resolveBlockAtBreakpoint(block, activeBp);
  const topOffset = reflow ? reflow.getOffset(block.id, storedGeom.y) : 0;
  // Container backgrounds (section, box) grow by the net delta of the
  // auto-height blocks they contain.
  const containerGrowth = isContainerBg && reflow
    ? reflow.getContainerGrowth(block, storedGeom)
    : 0;

  // When the editor forces a breakpoint via `?_bp=`, resolve geometry in
  // JS and pin it inline so the static stylesheet is overridden.
  let forcedStyle = null;
  if (forcedBreakpoint) {
    const g = storedGeom;
    if (g.hidden) return null;
    const bleed = getBlockBleed(block);
    const fullBleed = bleed === 'full';
    const fullWidth = !!block.fullWidth;
    const top = g.y + topOffset;
    const heightOverride = resolveBlockHeightCss(block);
    // Aspect-mode Hero Carousels (Task #2829) size themselves from width via
    // CSS aspect-ratio, mirroring the published stylesheet.
    const aspectStyle = resolveAspectSizingStyle(block);
    const height = aspectStyle
      ? 'auto'
      : (heightOverride || (isAutoHeight ? 'auto' : g.h + containerGrowth));
    if (fullBleed) {
      // In an embedded, pinned-width preview (the doc-import modal), `100vw`
      // resolves against the host browser window, not the pinned stage, so
      // full-bleed sections balloon past the stage and escape the dialog.
      // Constrain them to the stage instead so they fill it edge-to-edge
      // without overflowing.
      //
      // Task #2444: forced tablet/mobile previews (`?_bp=` iframe sized to
      // exactly 768/375px by the editor) also use the stage-filling branch.
      // The stage already spans the full iframe width there, and `100vw`
      // includes the iframe's vertical scrollbar width, so full-bleed blocks
      // (e.g. a Hero) overflowed the stage horizontally by the scrollbar
      // width. `?_bp=desktop` keeps `100vw` — its iframe can be wider than
      // the 1200px centred stage, so full-bleed must still break out of it.
      forcedStyle = (pinStageWidth || forcedBreakpoint !== 'desktop')
        ? { position: 'absolute', left: 0, right: 'auto', transform: 'none', width: '100%', top, height }
        : { position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: '100vw', top, height };
    } else if (bleed === 'left' || bleed === 'right') {
      // Task #3154: directional bleed — mirror geomRule's asymmetric
      // breakout. In pinned-width / forced tablet-mobile previews the stage
      // already spans the full iframe width (and 100vw would include the
      // scrollbar), so the stage-filling branch applies exactly as it does
      // for full bleed.
      forcedStyle = (pinStageWidth || forcedBreakpoint !== 'desktop')
        ? { position: 'absolute', left: 0, right: 'auto', transform: 'none', width: '100%', top, height }
        : {
            position: 'absolute',
            left: bleed === 'left' ? 'calc(50% - 50vw)' : 0,
            width: 'calc(50% + 50vw)',
            top,
            height,
          };
    } else if (fullWidth) {
      forcedStyle = { position: 'absolute', left: 0, top, width: '100%', height };
    } else {
      // Task #2460: clamp the rendered frame to the forced breakpoint's
      // stage width so the `?_bp=` preview matches the published CSS
      // (which emits clamped overrides) and the editor stage. Display
      // only — stored geometry is never rewritten.
      const cg = clampGeomToStage(g, forcedBreakpoint, BREAKPOINT_WIDTHS[forcedBreakpoint]);
      forcedStyle = { position: 'absolute', left: cg.x, top, width: cg.w, height };
    }
    if (aspectStyle) {
      // Pin the aspect sizing inline so the forced preview matches the
      // published CSS: ratio-driven height with optional min/max clamps.
      forcedStyle = {
        ...forcedStyle,
        ...(aspectStyle.aspectRatio ? { aspectRatio: aspectStyle.aspectRatio } : {}),
        ...(aspectStyle.minHeight ? { minHeight: aspectStyle.minHeight } : {}),
        ...(aspectStyle.maxHeight ? { maxHeight: aspectStyle.maxHeight } : {}),
      };
    }
  }

  // If we upgraded the wrapper to a semantic landmark tag, drop the
  // redundant role attribute. Otherwise carry the role through as an
  // attribute so screen readers still receive the author's intent.
  const usedLandmark = getSectionLandmarkTag(block?.type, a11y?.role);
  const explicitRole = a11y?.role && !usedLandmark ? a11y.role : undefined;

  // In CSS-layout mode (no forcedBreakpoint), positioning comes from the
  // stylesheet. For reflow we override `top` via inline style when there is
  // a push-down from an accordion above, force `height:auto` for accordion
  // blocks, and extend the section height when contained accordions grow.
  const cssReflowOverride = !forcedBreakpoint ? {
    ...(topOffset !== 0 ? { top: storedGeom.y + topOffset } : {}),
    ...(isAutoHeight ? { height: 'auto' } : {}),
    ...(isContainerBg && containerGrowth !== 0 ? { height: storedGeom.h + containerGrowth } : {}),
  } : {};

  return (
    <Tag
      id={block.anchorId || undefined}
      role={explicitRole}
      aria-label={a11y?.ariaLabel || undefined}
      data-cb={block.id}
      data-block-id={block.id}
      data-block-type={block.type}
      data-full-bleed={getBlockBleed(block) === 'full' ? 'true' : undefined}
      data-bleed={(() => { const d = getBlockBleed(block); return d === 'left' || d === 'right' ? d : undefined; })()}
      style={{
        ...(forcedStyle || null),
        ...cssReflowOverride,
        // Task #3181: gradient/image sections must not paint the wrapper fill
        // (shared resolver — keeps editor, public and symbol preview in sync).
        background: resolveWrapperBackground(block),
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderStyle: style.borderStyle,
        // Task #3177: bleeding blocks square off the corners on the bled
        // viewport edge; non-bleed blocks keep the stored radius verbatim.
        borderRadius: resolveBleedBorderRadius(block),
        opacity: style.opacity,
        boxShadow: resolveBoxShadowCss(style),
        zIndex: style.zIndex,
        // Task #2506: absoluteFill blocks (Hero, Hero Carousel) consume
        // block.style.padding* inside their own renderer (`absolute inset-0`
        // spans the padding box, making wrapper padding visually inert), and
        // with border-box a padding sum wider than the block (auto-built
        // heroes carry 200+200px) force-expands the wrapper past the 375px
        // stage. Skip wrapper padding for them on every surface.
        paddingTop: def?.absoluteFill ? 0 : (style.paddingTop || 0),
        paddingRight: def?.absoluteFill ? 0 : (style.paddingRight || 0),
        paddingBottom: def?.absoluteFill ? 0 : (style.paddingBottom || 0),
        paddingLeft: def?.absoluteFill ? 0 : (style.paddingLeft || 0),
        boxSizing: 'border-box',
        overflow: (isSection || def?.allowOverflow) ? 'visible' : 'hidden',
      }}
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

// Task #1446: in-page anchor smooth-scroll.
//
// Authors give blocks an `anchorId` (emitted as the wrapper element's `id`)
// and link to them with `#anchor-id` hrefs. This hook makes those links
// scroll smoothly to the target *without* a SPA route change, which matters
// inside the editor's preview iframe (a real hash navigation would reload /
// re-route the embedded app). It also:
//   - honours prefers-reduced-motion (jumps instantly instead of animating),
//   - offsets the scroll by any sticky/fixed header height so the target
//     isn't hidden underneath it,
//   - handles an initial `#hash` on first load.
// Same-page only: links whose target id is not present on this page are left
// alone so normal navigation still works.
function useAnchorSmoothScroll(containerRef, enabled) {
  const prefersReducedMotion = () => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  };

  // Measure the tallest sticky/fixed element pinned to the top of the
  // viewport so we can offset the scroll target below it.
  const stickyHeaderOffset = useCallback(() => {
    if (typeof document === 'undefined') return 0;
    let max = 0;
    const candidates = document.querySelectorAll('header, nav, [data-canvas-sticky]');
    candidates.forEach((el) => {
      try {
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
        const rect = el.getBoundingClientRect();
        // Only count headers actually pinned near the top of the viewport.
        if (rect.top <= 1 && rect.height > max) max = rect.height;
      } catch { /* ignore */ }
    });
    return max;
  }, []);

  const scrollToId = useCallback((rawId, { smooth }) => {
    if (!rawId) return false;
    let target = null;
    try {
      target = document.getElementById(rawId);
    } catch {
      target = null;
    }
    if (!target) return false;
    const offset = stickyHeaderOffset();
    const top = window.pageYOffset + target.getBoundingClientRect().top - offset - 8;
    const behavior = smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
    try {
      window.scrollTo({ top: Math.max(0, top), behavior });
    } catch {
      window.scrollTo(0, Math.max(0, top));
    }
    // Move focus to the target for keyboard/screen-reader users without
    // forcing a second jump (focus would otherwise scroll the target into
    // view at the top, ignoring our header offset).
    try {
      const hadTabIndex = target.hasAttribute('tabindex');
      if (!hadTabIndex) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      if (!hadTabIndex) {
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
      }
    } catch { /* ignore */ }
    return true;
  }, [stickyHeaderOffset]);

  // Intercept same-page anchor clicks within the rendered page.
  useEffect(() => {
    if (!enabled) return;
    const root = containerRef.current;
    if (!root) return;

    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target?.closest?.('a[href]');
      if (!anchor || !root.contains(anchor)) return;
      const href = anchor.getAttribute('href') || '';
      // Resolve the in-page anchor id this link targets, if any.
      //   "#id"            -> always same-page.
      //   "/this-page#id"  -> (Task #1448) same-page when the path matches the
      //                       page we're on, so we smooth-scroll instead of
      //                       triggering a wasteful full reload of the same page.
      //   "/other#id"      -> cross-page: fall through to normal navigation;
      //                       the destination page scrolls to the anchor on
      //                       arrival via the initial-#hash handler below.
      let id = null;
      if (href.startsWith('#')) {
        if (href.length < 2) return;
        id = decodeURIComponent(href.slice(1));
      } else {
        const hashIdx = href.indexOf('#');
        if (hashIdx < 1) return; // no hash, or bare "#…" already handled
        const path = href.slice(0, hashIdx);
        const rawId = href.slice(hashIdx + 1);
        if (!rawId) return;
        // Only same-origin, path-style links ("/slug") are candidates; leave
        // absolute URLs (http(s)://, mailto:, tel:) to the browser.
        if (!path.startsWith('/')) return;
        let samePath = false;
        try {
          const norm = (p) => (p.replace(/\/+$/, '') || '/');
          samePath = norm(path) === norm(window.location.pathname);
        } catch { samePath = false; }
        if (!samePath) return; // cross-page link — let navigation happen
        id = decodeURIComponent(rawId);
      }
      if (id && scrollToId(id, { smooth: true })) {
        e.preventDefault();
        // Reflect the hash in the URL without triggering a hashchange-driven
        // route change. Skip inside the preview iframe to avoid mutating the
        // editor's URL.
        const inPreview = window.parent !== window;
        if (!inPreview) {
          try {
            window.history.replaceState(null, '', `#${id}`);
          } catch { /* ignore */ }
        }
      }
    };

    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [enabled, containerRef, scrollToId]);

  // Honour an initial #hash on load (after blocks have mounted).
  useEffect(() => {
    if (!enabled) return;
    let hash = '';
    try {
      hash = decodeURIComponent((window.location.hash || '').slice(1));
    } catch {
      hash = '';
    }
    if (!hash) return;
    // Defer until the page tree + images have a chance to lay out so the
    // target's position is accurate.
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToId(hash, { smooth: false }));
    });
    return () => cancelAnimationFrame(id);
  }, [enabled, scrollToId]);
}

/**
 * Inner stage element that lives inside AccordionReflowProvider so it can
 * read getTotalGrowth() and extend the stage height when accordions expand.
 * The CSS stylesheet sets an explicit `height:` on .canvas-stage; we override
 * it via `minHeight` so blocks that are pushed down are never clipped.
 */
function CanvasPageStage({ children, lcpBlockId, forcedBreakpoint, windowBp, activeBp, pinStageWidth }) {
  const reflow = useAccordionReflow();
  const growth = reflow ? reflow.getTotalGrowth() : 0;
  // Baseline stage height at the active breakpoint from stored geometry.
  const baseHeight = useMemo(
    () => stageHeightForBreakpoint(children, activeBp, { buffer: 0 }),
    [children, activeBp],
  );
  // - growth > 0: minHeight overrides the CSS `height` when larger (stage grows)
  // - growth = 0: no override (CSS height is authoritative)
  // - growth < 0 (Task #2824 — only rows of aspect-height Hero Carousels can
  //   report signed shrink): override `height` directly so the stage pulls
  //   the page bottom up with the shrunken carousel instead of leaving a
  //   dead gap. All other rows are push-down-only, so author-intended gaps
  //   are still preserved exactly as the editor shows them.
  const netHeight = baseHeight + growth;
  const stageStyle = growth > 0
    ? { minHeight: netHeight }
    : (growth < 0 ? { height: Math.max(0, netHeight) } : undefined);

  // Embedded previews (forceBreakpoint prop) live in the host document, not
  // a device-sized iframe, so the viewport-based @media rules in the page
  // stylesheet would otherwise shrink the stage to the host window's
  // breakpoint. Pin the stage width to the forced breakpoint so its layout
  // width is deterministic and auto-height text wraps exactly as the server
  // assumed — matching the built page and preventing title/divider overlap.
  const forcedWidthStyle = pinStageWidth && forcedBreakpoint
    ? { width: BREAKPOINT_WIDTHS[forcedBreakpoint], maxWidth: BREAKPOINT_WIDTHS[forcedBreakpoint] }
    : null;

  return (
    <main
      id="canvas-main-content"
      tabIndex={-1}
      className="canvas-stage focus:outline-none"
      style={{ ...(forcedWidthStyle || {}), ...(stageStyle || {}) }}
      data-testid="canvas-page-stage"
    >
      {children.map((b) => (
        <CanvasBlockRender
          key={b.id}
          block={b}
          lcpBlockId={lcpBlockId}
          forcedBreakpoint={forcedBreakpoint}
          windowBp={windowBp}
          pinStageWidth={pinStageWidth}
        />
      ))}
    </main>
  );
}

export default function CanvasPageRenderer({ page, symbols, forceBreakpoint }) {
  const baseDesign = useMemo(() => normalizeCanvasDesign(page?.canvas_design), [page?.canvas_design]);
  // Task #2570 — v2 (flow / auto-layout) documents take a separate render path
  // (CanvasFlowStage, driven by resolveFlowLayout). v1 (absolute) documents keep
  // the legacy CSS-positioned renderer below unchanged. `normalizeCanvasDesign`
  // already routed a v2 doc through the flow normalizer.
  const isFlow = useMemo(() => isFlowDesign(baseDesign), [baseDesign]);
  const symbolsById = useSymbolsForDesign(baseDesign, symbols);
  const theme = useTenantCanvasTheme();
  const design = useMemo(
    // Symbol splicing is a v1-only transform; leave flow documents untouched.
    () => (isFlow ? baseDesign : resolveSymbolsInDesign(baseDesign, symbolsById) || baseDesign),
    [isFlow, baseDesign, symbolsById],
  );
  // Splice symbol children into the flat block list so the CSS layout
  // generator picks them up. Symbols themselves render as transparent
  // wrappers; their children take over geometry.
  const children = useMemo(() => {
    // Read the already-resolved root children directly from the resolved
    // design. Do NOT call getRootChildren(design) here: it re-runs the design
    // through normalizeCanvasDesign, which strips the non-standard
    // __symbolChildren field that resolveSymbolsInDesign attached, leaving the
    // splice loop below with nothing to splice (Task #1675).
    const root = design?.root?.sections?.[0]?.children || [];
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

  const windowBp = useWindowBreakpoint();
  const hasBlocks = children.length > 0;
  const flowHasNodes = useMemo(
    () => isFlow && (design?.root?.sections || []).some((s) => (s.children?.length || 0) > 0),
    [isFlow, design],
  );
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
  // Task #2648 — static first-paint stylesheet for v2 (flow) pages: absolute
  // boxes + tablet/mobile @media rules so the page is breakpoint-correct before
  // CanvasFlowStage's client-side measurement loop runs. Its inline styles take
  // over (and override this) once measured, so there is no visible shift.
  const flowCss = useMemo(
    () => (isFlow && flowHasNodes ? buildFlowCanvasCss(design, `#${scopeId}`) : ''),
    [isFlow, flowHasNodes, design, scopeId],
  );
  const lcpBlockId = useMemo(() => (hasBlocks ? findLcpBlockId(children) : null), [children, hasBlocks]);

  // An explicit `forceBreakpoint` prop (embedded previews) takes precedence
  // over the editor iframe's `?_bp=` URL param so a preview can request
  // desktop geometry without depending on the host window size.
  const urlForcedBreakpoint = useForcedBreakpoint();
  const forcedBreakpoint = forceBreakpoint || urlForcedBreakpoint;

  // Task #1446: smooth-scroll same-page anchor links to their target block.
  const containerRef = useRef(null);
  useAnchorSmoothScroll(containerRef, hasBlocks);

  // When this renderer is shown inside the Canvas Page Editor's preview
  // iframe (`?_canvasPreview=<nonce>`), notify the editor once the page
  // tree is mounted, images attached to blocks have loaded, and webfonts
  // are ready. The editor uses this handshake to wait for the SPA to
  // finish rendering before kicking off an axe-core scan — replacing the
  // old fixed `setTimeout(400)` wait that scanned a partially-rendered
  // DOM. We re-fire whenever the resolved `design` changes (e.g. symbols
  // land asynchronously) so the editor's last-known ready signal always
  // reflects the latest stable render.
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;
    let nonce;
    let publicView;
    try {
      const sp = new URLSearchParams(window.location.search);
      const rawNonce = sp.get('_canvasPreview');
      if (rawNonce == null) return;
      const parsed = Number(rawNonce);
      nonce = Number.isFinite(parsed) ? parsed : rawNonce;
      publicView = sp.get('_publicView') === '1';
    } catch {
      return;
    }
    let cancelled = false;
    const rafIds = [];
    const send = () => {
      if (cancelled) return;
      try {
        window.parent.postMessage(
          { type: 'canvas-preview-ready', nonce, publicView },
          '*',
        );
      } catch { /* cross-origin parents will just miss the signal */ }
    };
    const ready = async () => {
      try {
        const imgs = Array.from(document.images || []);
        await Promise.all(imgs.map((img) => (
          img.complete
            ? Promise.resolve()
            : new Promise((res) => {
                img.addEventListener('load', res, { once: true });
                img.addEventListener('error', res, { once: true });
              })
        )));
      } catch { /* best-effort */ }
      try {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
      } catch { /* best-effort */ }
      if (cancelled) return;
      await new Promise((res) => {
        rafIds.push(requestAnimationFrame(() => {
          rafIds.push(requestAnimationFrame(res));
        }));
      });
      send();
    };
    // Defer to the next microtask so the just-committed children are
    // actually in the DOM when we start counting images.
    const t = setTimeout(ready, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
      rafIds.forEach((id) => cancelAnimationFrame(id));
    };
  }, [design, hasBlocks]);

  // Task #2570 — v2 (flow) render path. Same outer scaffold (scope id,
  // skip-link, a11y + theme CSS) as the v1 path, but the stage is laid out by
  // the shared flow engine instead of the per-page absolute CSS.
  if (isFlow) {
    if (!flowHasNodes) {
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
      <TooltipProvider>
        <div
          ref={containerRef}
          id={scopeId}
          className="canvas-page w-full"
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
          {themeCss && (
            <style dangerouslySetInnerHTML={{ __html: `#${scopeId}{${themeCss}}` }} />
          )}
          {flowCss && <style dangerouslySetInnerHTML={{ __html: flowCss }} />}
          <CanvasFlowStage
            design={design}
            forceBreakpoint={forcedBreakpoint}
            lcpBlockId={null}
          />
        </div>
      </TooltipProvider>
    );
  }

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
    <TooltipProvider>
    <div
      ref={containerRef}
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
      <AccordionReflowProvider
        blocks={children}
        breakpoint={forcedBreakpoint || windowBp || 'desktop'}
        resolveGeom={(b) => resolveBlockAtBreakpoint(b, forcedBreakpoint || windowBp || 'desktop')}
      >
        <CanvasPageStage
          children={children}
          lcpBlockId={lcpBlockId}
          forcedBreakpoint={forcedBreakpoint}
          windowBp={windowBp}
          activeBp={forcedBreakpoint || windowBp || 'desktop'}
          pinStageWidth={!!forceBreakpoint}
        />
      </AccordionReflowProvider>
    </div>
    </TooltipProvider>
  );
}
