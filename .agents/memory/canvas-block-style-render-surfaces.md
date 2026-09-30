---
name: Canvas block.style render surfaces
description: Every new block.style visual property must be applied on all Canvas render surfaces or the builder and published page drift.
---

# Adding a new `block.style` visual property (Canvas)

A visual property on `block.style` (background, border*, opacity, boxShadow, …)
is applied INLINE on the wrapper in **five** places, not one. Add the new
property to `DEFAULT_STYLE` in `client/src/lib/canvasDesign.js` (so
createBlock/normalizeBlock backfill it) AND to every render surface:

1. `CanvasStage.jsx` — v1 builder stage (`CanvasBlockView`)
2. `CanvasPageRenderer.jsx` — v1 public renderer (`CanvasBlockRender`)
3. `CanvasFlowEditorStage.jsx` — v2 flow editor: BOTH `FlowLeaf` (leaves:
   Box/Image) and `FlowContainer` (containers: Section)
4. `CanvasFlowStage.jsx` — v2 flow public renderer (`FlowNode`, handles both)
5. `blocks/registry.jsx` `SymbolChildPreview` — editor-side mirror of the
   public wrapper for symbol children

**Why:** miss any one and the property renders on some surfaces but not others
(e.g. shows in the builder, absent on the published page, or absent inside
symbols). Section is a v2 flow *container* while Box/Image are *leaves*, so the
flow editor needs the property in two components.

**How to apply:** keep the CSS derivation in ONE exported resolver in
canvasDesign.js (e.g. `resolveBoxShadowCss(style)`) and call it on every
surface; default the new field so unknown/legacy values are inert (existing
pages stay byte-identical).
