---
name: Canvas spatial reflow lanes
description: How V1 absolute-canvas auto-height growth propagates through columns without coupling unrelated content.
---

**Rule:** Public/runtime auto-height reflow is spatial and collision-based. A
source affects only targets below it whose resolved horizontal bounds overlap,
and only when its final visible bottom crosses the target's authored top. The
target moves by that overlap, not by the source's raw height delta. Parallel
lanes contribute the deepest collision path rather than being summed.

**Why:** Raw growth offsets moved content even when an authored gap fully
absorbed an accordion expansion. A simple overlap filter is also insufficient:
it double-counts side-by-side sources for a spanning target and fails when a
moved source must relay only the collision left after later gaps.

**How to apply:** Propagate final visible bottoms through the active
breakpoint's resolved lanes. Apply signed aspect-carousel movement as the base
position before collision checks, so upstream pushes and signed shrink/grow
compose without overlap. A displaced non-auto content block becomes a
zero-growth collision relay; Section and Box backgrounds do not. Size
containers and the stage from final rendered bottoms. Editor displacement
remains zero.