---
name: Canvas ruler guides (editor-only)
description: How draggable alignment guides are stored, rendered, and kept out of public render in CanvasBuilder.
---

# Canvas ruler guides

Editors drag alignment guides out of the horizontal/vertical rulers in CanvasBuilder (Figma-style). Stored at `design.root.guides = { vertical:[{pos,locked}...], horizontal:[{pos,locked}...] }` — each guide is a `{pos, locked}` object (was plain `number[]` in v1; `normalizeGuides` still coerces bare numbers for back-compat). A single set shared across all breakpoints (no per-breakpoint guides).

**Locked guides + typed positions.** Locked guides ignore drag/Delete (gated in `startGuideMove` and the overlay grab-strip handler) but still snap. Snapping consumes plain positions via `getCanvasGuidePositions(design)` — locked state is irrelevant to the stage. The overlay (`CanvasGuides.jsx`) renders a per-guide chip near the ruler origin with a lock toggle + a double-click-to-type numeric position input; the chip is `pointer-events-auto` and `stopPropagation`s pointerdown so it never starts a drag.

**Editor-only metadata.** Guides live at `root.guides` and the public renderer (`CanvasPageRenderer.jsx`) only reads `root.sections`/children, so guides can never leak to live/preview pages. Any future read path that serializes the whole design for public output must keep ignoring `root.guides`.

**Overlay must render OUTSIDE the zoom-scaled stage div.** The guides overlay (`CanvasGuides.jsx`) is positioned in *screen pixels* (stage coord × zoom) inside a `position:relative` wrapper that also holds the `transform:scale(zoom)` stage div. **Why:** rendering lines inside the scaled div would make the 1px lines blurry/scaled and the px readout label would shrink/grow with zoom. The wrapper's top-left == stage origin, so `clientToStage` converts pointer coords via the wrapper's `getBoundingClientRect()` and `/zoom` — this also makes scroll position automatically correct.

**Keyboard ownership during a guide drag.** While a guide is grabbed, a `guideDragRef` guard at the top of the block-level `keydown` handler makes it bail early, so Delete removes/cancels the guide instead of also deleting selected blocks (both listeners are on `window`; the block one is bound first, so stopImmediatePropagation in the guide handler is too late — the ref guard is the reliable fix).

**Drag state is split** into an immutable descriptor (`guideDrag` = kind/orientation/index) and a live `guidePreview` (value/removing). **Why:** the window pointermove/up listener effect depends only on the descriptor, so per-move value updates don't re-subscribe the listeners.

Persistence/undo: all guide mutations go through `setCanvasGuides(design, …)` inside `setDesign(...)`, so they ride the existing debounced autosave + undo/redo history with no special handling. `normalizeGuides` (in `canvasDesign.js`) coerces both axes to finite ints ≥0, dedupes, and sorts ascending — so guide indices always match the sorted stored order.
