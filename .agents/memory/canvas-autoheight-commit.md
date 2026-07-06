---
name: Baking auto-height reflow into stored geometry
description: Why committing an auto-height block's measured height must also bake the reflow's downstream offsets, or blocks below overlap.
---

Auto-height canvas blocks (Text, FAQ/Accordion — `def.autoHeight` in the block
registry) render at `height:auto`, but their stored `geom.h` never tracks the
real content height. `stageHeightForBreakpoint` / `buildCanvasCss` derive the
stage height from stored geometry, so the published (SSR/CSS) stage is too short
and content overflows into the footer until JS runs the runtime minHeight patch.

`AccordionReflowContext` compensates ONLY at read time:
- `getOffset(id, storedY)` pushes a block down by `Σ(measured − stored h)` for
  every auto-height block *entirely above* it (`storedBottom <= storedY`).
- `getSectionGrowth(section, geom)` grows a Section by the same delta for
  auto-height blocks geometrically *contained* in it.
- `getTotalGrowth()` extends the stage minHeight.

**The rule:** if you commit an auto-height block's measured height into its
stored `geom.h`, you MUST atomically bake the reflow's downstream effects in the
same commit — push every block entirely below it by the delta, and grow every
containing Section by the delta.

**Why:** `getOffset` is `measured − stored h`. The moment stored h == measured,
that term is 0, so the runtime push for blocks below vanishes. Commit height
alone and blocks below snap up and overlap the taller block (visible even in
normal forward authoring the instant the debounced commit fires). Baking all
three mirrors what the runtime already paints, so there is zero visual change —
you are just persisting it so SSR/CSS is correct and the runtime reflow
collapses to a no-op for the authored/collapsed state (genuine visitor-driven
expansion like opening an accordion still reflows live).

**How to apply:** the editor commit lives in `CanvasBuilder.jsx`
(`commitAutoHeight`), fed by `AccordionReflowProvider`'s optional `onMeasure`
prop (wired only in the editor via `CanvasStage`; the published
`CanvasPageRenderer` passes no `onMeasure` so it stays pure read-time reflow).
The commit is debounced per block, `skipHistoryRef`-flagged (no undo spam), and
uses a 2px dead-band. The tree is FLAT — Sections and their "contained" blocks
are siblings; containment is purely geometric, matching the reflow helpers.
Committing h/y never changes a block's rendered height (auto stays auto; pushes
only move `top`), so there is no measure→commit→re-measure loop.
