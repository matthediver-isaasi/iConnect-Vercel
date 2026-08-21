---
name: Canvas spatial reflow lanes
description: How V1 absolute-canvas auto-height growth propagates through columns without coupling unrelated content.
---

**Rule:** Public/runtime auto-height reflow is spatial. A source affects only
targets below it whose resolved horizontal bounds overlap. Growth stacked in one
lane accumulates; growth from parallel lanes contributes the maximum path rather
than being summed. Full-width/bleed targets overlap every lane, while card
members keep their intentional cross-column row equalisation.

**Why:** Vertical-only offsets made an accordion in one column move unrelated
content in another. A simple overlap filter is not enough: it double-counts two
side-by-side growing sources for a spanning target and can miss cumulative
growth down one column.

**How to apply:** Use the active breakpoint's resolved geometry for both sources
and targets. Keep ordinary text/accordion growth non-negative, preserve the
signed aspect-carousel exception, and use the same spatial path for block
offsets, containing backgrounds, and live stage height. Editor live displacement
remains zero; changing persisted auto-height bake geometry is a separate scope.