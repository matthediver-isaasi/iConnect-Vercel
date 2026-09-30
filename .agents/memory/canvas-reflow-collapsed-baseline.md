---
name: Canvas public reflow collapsed baseline
description: Why accordion push-down on public canvas pages measures growth from a collapsed baseline, not the stored box height.
---

Public Canvas reflow (AccordionReflowProvider, editorMode omitted) computes each
row's push-down "growth" from a REFERENCE bottom, not the stored box bottom.

- For plain auto-height blocks (`autoHeight && !cardGrow` → accordion, text) the
  reference is the block's COLLAPSED BASELINE: the smallest height ever measured
  (accordions mount collapsed, so first measurement = collapsed), capped at the
  stored box height. Growth = `measured − min(baseline, storedH)`, clamped ≥ 0.
- For cards (`cardGrow`) and everything else the reference stays the stored box
  height, so row equalisation and manual resizes are untouched.

**Why:** The push-down-only clamp (measure growth vs stored box, `max(0, …)`)
was correct for preserving author-intended gaps but killed the accordion
push-down: when an accordion's stored box is taller than its collapsed state,
`expanded − storedH` clamps to 0, so nothing below moves. Measuring from the
collapsed baseline restores the visible push-down without reintroducing the
pull-up (static content keeps `measured == baseline`, so its growth is
unchanged and gaps are preserved).

**How to apply:** Baseline is a per-block running minimum kept in a ref; it is
breakpoint-specific (a question wraps taller on narrow layouts) so it is reset
whenever the provider's `breakpoint` prop changes and repopulated by the
ResizeObserver re-measure. `getOffset`/`getSectionGrowth` still compare against
STORED bottoms (`grp.bottom`); only the growth magnitude changed. Editor mode
never consumes growth, so this only affects the public renderer.
