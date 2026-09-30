---
name: Canvas v2 flow first-paint static CSS
description: How auto-layout (v2 flow) Canvas pages get breakpoint-correct first paint before JS, mirroring v1 buildCanvasCss.
---

# Canvas v2 flow first-paint static stylesheet

v1 (free/absolute) Canvas pages ship a static per-page stylesheet
(`buildCanvasCss` in `canvasDesign.js`) so they lay out correctly before JS.
v2 (flow / auto-layout) pages historically laid out only via runtime JS
measurement in `CanvasFlowStage.jsx`, so crawlers / slow / no-JS visitors saw a
wrong or unlaid-out first paint, and JS visitors could see CLS on hydration.

**The fix / model (Task #2648):**
- `buildFlowCanvasCss(design, scope)` in `canvasFlowLayout.js` — pure, React-free
  (same constraints as `resolveFlowLayout`). Runs `resolveFlowLayout` at the three
  fixed BREAKPOINT_WIDTHS with NO measured heights, emits a scoped stage rule +
  per-node `[data-cb="id"]` absolute-box rules in DFS/paint order. Auto-height
  leaves -> `height:auto`. Tablet/mobile are `(max-width)` @media overrides,
  diffed vs the previous breakpoint (only real diffs emitted), each with a
  per-breakpoint stage `min-height` (reserves vertical space -> no CLS).
- `CanvasFlowStage` renders the **union** of nodes placed at ANY breakpoint (not
  just the initial desktop set), so @media rules can reveal/hide per breakpoint on
  first paint.
- A `hydrated` gate swaps geometry sources: pre-measurement the static stylesheet
  drives geom (component emits NO inline geometry and NO stage min-height);
  after the first layout-phase measurement pass, inline engine geometry takes over
  (`display:none` for nodes not placed at the current measured breakpoint). Set in
  a `useLayoutEffect(..., [])` so the swap happens before paint (no visible shift).

**Why:** first paint must be breakpoint-correct for SEO/crawlers/slow links, and
hydration must not cause layout shift. Static CSS = the pre-JS truth; inline
engine geom = the measured, content-accurate final truth.

**How to apply:**
- Forced/embedded previews (`forceBreakpoint`, editor `?_bp=`) start `hydrated=true`
  so inline geom pins immediately — v1/editor behaviour unchanged.
- App is pure CSR (`createRoot`, not `hydrateRoot`); `prerender.js` is a separate
  semantic-body bot path and is NOT involved here.
- If you add/change how flow geometry resolves, keep `buildFlowCanvasCss` and the
  `CanvasFlowStage` inline geom in lockstep or first paint drifts from hydrated.
