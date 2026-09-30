---
name: Canvas card row height equalization
description: How Canvas cards get vertical grow + per-row equal heights via the reflow context.
---

Canvas CARD blocks are `autoHeight` (wrapper renders `height:auto` in both
CanvasStage and CanvasPageRenderer). Vertical sizing is driven by the reflow
context (AccordionReflowContext), NOT by CSS geometry height.

## Model
- Each card reports its NATURAL content height via `useReportCardContentHeight`,
  measured as `outer - spacer` (a flex spacer div sits between the card body and
  the CTA). Measuring the subtrahend avoids a feedback loop: applying a
  min-height to the box would otherwise inflate the measurement.
- `rowGroups` groups blocks sharing a row. Per row it computes
  `renderedHeight = max(effectiveH)` where `effectiveH = max(measuredContent, floor)`
  and `floor = manualHeight ? storedGeomH : 0`. Signed band growth is
  `(top + renderedHeight) - maxStoredBottom`.
- `getRowHeight(id)` returns the row's renderedHeight; CardRender applies it as
  `min-height` on the card box, and the flex spacer pushes the CTA to the bottom.

## Two independent behaviors
- **Content-driven equalization** (no manual height): shorter cards fill to the
  tallest card's content; band growth is negative so blocks below pull UP.
- **Manual grow** (n/s drag): stored as real per-breakpoint geometry `h` PLUS a
  `manualHeight` flag (the floor). Resize CLAMPS up to the captured content floor
  so dragging down snaps to content and never clips.

**Why:** equalization is render-only (min-height). It intentionally does NOT
reflow-push blocks below, because the tallest member's stored geometry already
reserves the row's bottom band (maxStoredBottom). Pushing again would
double-count.

## How to apply
- `manualHeight` lives in the active breakpoint's geometry (via
  CanvasBuilder.applyGeometry) so it inherits + round-trips like other bp
  overrides; `buildCanvasCss`/geomRule ignore it (no CSS impact).
- Any new resizable auto-height block that needs row equalization should reuse
  the same hook + rowGroups path rather than storing CSS height.
