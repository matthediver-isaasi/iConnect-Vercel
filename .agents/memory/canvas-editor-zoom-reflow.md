---
name: Canvas editor zoom vs. reflow measurement
description: Editor zoom is a CSS transform, so every getBoundingClientRect reflow measurement is inflated by zoom and must be divided before it is baked into stored geometry.
---

Editor zoom in the Canvas Builder is applied as `transform: scale(zoom)` on the
stage wrapper. This means **every `getBoundingClientRect()` read of a measured
element returns dimensions AFTER the transform** — a block that is 200px tall in
true stage coordinates measures 300px at 150% zoom.

The auto-height / auto-size reflow pipeline bakes measured dimensions back into
stored geometry. If a transform-inflated measurement is baked, zooming in
silently grows blocks/sections/cards and corrupts the saved page.

**Rule:** any editor-side reflow measurement that reads a rect must divide the
rect dimension by the active zoom before reporting/baking. Use the shared pure
helper `normalizeMeasuredLength(scaledPx, zoom)` (in `autoHeightBake.js`).

**Do NOT divide `getComputedStyle` values** (margin/padding/border): those are
resolved layout-pixel values that the CSS transform does not scale. Add them
back un-divided.

**Why:** getBoundingClientRect is post-transform; getComputedStyle is
pre-transform layout px. Mixing them without this distinction bakes zoom into the
saved layout.

**How to apply:**
- Measurement sites live in `AccordionReflowContext.jsx` (`measureReflowHeight`,
  `useReportCardContentHeight`, `useReportButtonBounds`). Each keeps a `zoomRef`
  updated every render from `reflow.zoom` so a pure zoom change does NOT re-bind
  its ResizeObserver.
- Zoom is threaded: `CanvasBuilder` → `CanvasStage` → `AccordionReflowProvider`
  (`zoom` prop, default 1) → context. `useAutoHeightBake({ zoom })` includes
  `zoom` in the settle-gate effect deps so a zoom change re-closes the gate and
  cancels any pending commit (same as a breakpoint switch), preventing a
  transient mid-transition measurement from baking.
- **Public path never zooms** — `zoom` defaults to 1 everywhere, so division is a
  no-op and `CanvasPageRenderer` output stays byte-identical. Keep it that way.
- Adding a new measured block? Thread `zoom` through its measurement the same
  way, or its baked height will drift with the author's zoom level.
