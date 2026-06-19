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
