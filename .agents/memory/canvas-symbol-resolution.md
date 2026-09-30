---
name: Canvas symbol resolution (read-time)
description: How symbol instances resolve to real content in the public renderer vs the editor, and why it's a read-time transform.
---

# Canvas symbol resolution

Symbol instances (`BLOCK_TYPES.SYMBOL`, content.symbolId) render real content via a **read-time transform** — the persisted page design only ever stores the symbol reference, never the resolved children. There are TWO independent resolution paths:

- **Public renderer**: `resolveSymbolsInDesign` (canvasDesign.js) attaches `__symbolChildren` to each symbol block; `CanvasPageRenderer` splices those children into the flat block list as siblings and does NOT render the symbol wrapper itself. `SymbolRender` returns null when `__symbolChildren` is present. Symbols fetched from `/api/public/canvas-symbols` (host-resolved tenant, anonymous-readable).
- **Editor**: `SymbolRender` (asEditor) draws the children itself, in-place, by reading the symbol's full design from `CanvasSymbolsProvider`/`useCanvasSymbols` (fetches authenticated `/api/canvas-symbols?full=1`). Each child rendered via `SymbolChildPreview` mirroring the public per-block wrapper. The instance stays one selectable unit because CanvasStage wraps EditorComponent in a `pointer-events-none` overlay, so inner clicks fall through to the box.

**Why:** keeps saved data clean (symbol edits propagate everywhere automatically) and keeps the public renderer output byte-identical regardless of editor preview logic.

**How to apply:** `SymbolRender` is registered as BOTH Editor and Renderer, so it must branch on `asEditor`. Any new symbol behavior must not write resolved children back into the design. The SYMBOL def has `allowOverflow: true` so children exceeding the instance box aren't clipped in the editor (matches published, where children are absolute siblings). Distinguish "loading" vs "missing symbol" via the context's `loaded` flag, not map emptiness.

**Layout analysis:** any code that reasons about page geometry (auto-layout, overlap/cluster detection, spacing audits) must substitute the symbol's `symbolContentExtent` for the stored w/h — the stored box is a placeholder and can be wildly larger/smaller than the rendered content (e.g. a 600×240 box holding a 560×24 divider), which corrupts overlay-containment and cluster grouping. Auto build also cannot make symbol *content* responsive; a fixed-width symbol design overflowing a narrow stage is the symbol's own responsibility.

**Box-fitting:** the symbol instance box is fitted to content at read time, never persisted. `symbolContentExtent` measures the content extent over visible root children — symbols are authored top-left at origin (the Symbols dialog normalizes them), so the box origin stays at the host x/y and only w/h derive from content. The editor builds a display-only children set with fitted w/h and feeds it to both the stage and the stage-height calc; geometry commits persist ONLY x/y for symbols, never w/h. **Why:** keeps move/resize handles aligned with drawn content without dirtying saved data or undo/redo. **Critical:** fit ALL breakpoints, not just ones the instance already overrode — symbol content can resolve to a different extent at tablet/mobile, so a desktop-only fit leaves non-desktop boxes wrong. Write only w/h on each breakpoint frame (never x/y) so `resolveBlockAtBreakpoint` still cascades x/y from desktop and any real per-breakpoint x/y override survives.

**Per-breakpoint frames (Aug 2026):** symbol saves must translate EVERY breakpoint's explicit x/y to the symbol-local origin using each breakpoint's OWN bounding origin (desktop-only translation left tablet/mobile page-absolute -> desktop layout shown on mobile). Shared idempotent helper `normalizeSymbolDesignFrames` in canvasDesign.js runs at save time (Symbols dialog) AND defensively at read time (symbolContentExtent, resolveSymbolsInDesign, SymbolRender editor preview) so legacy symbols self-heal. Frames without explicit x/y stay untouched so they keep cascading from desktop.
