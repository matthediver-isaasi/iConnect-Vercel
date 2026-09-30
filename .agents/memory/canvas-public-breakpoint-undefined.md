---
name: Canvas public renderer passes no breakpoint
description: Why per-breakpoint block settings baked into inline styles silently render desktop-only on public v1 pages, and the fix pattern.
---

The v1 public page renderer (`CanvasPageRenderer`) renders block Renderers with `breakpoint={undefined}` — the visitor's real viewport is supposed to decide. Any block that resolves a per-breakpoint content setting (column counts, sizes) into an **inline style** therefore silently falls back to the desktop value on public pages, while looking correct in the editor (which always passes a real breakpoint).

**Why:** inline styles can't be media-query responsive; the editor/preview and flow (v2) paths always pass `'desktop'|'tablet'|'mobile'`, masking the bug.

**How to apply:** for any per-breakpoint visual knob, branch on `isPreview = breakpoint is one of the three names`. Editor keeps the inline style; public path emits a `<style>` with base + `@media (max-width: BREAKPOINT_MAX_PX.tablet/mobile)` rules scoped to `[data-cb="<blockId>"] [data-testid=...]` (see `buildResponsiveListGridCss` in dynamicBlocks.jsx and `buildResponsiveColumnsCss` in registry.jsx). Preserve fallback semantics `c[bp] || c.desktop`, and skip a media rule when it equals the wider breakpoint (cascade covers it). Flow (v2) public pages are unaffected — `CanvasFlowStage` always passes a real breakpoint.
