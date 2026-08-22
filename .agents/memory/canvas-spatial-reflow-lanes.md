---
name: Canvas spatial reflow lanes
description: How V1 absolute-canvas auto-height growth propagates through columns without coupling unrelated content.
---

**Rule:** Public/runtime auto-height reflow is spatial and collision-based. A
source affects only targets below it whose resolved horizontal bounds overlap,
and only when its final visible bottom crosses the target's current top. Before
that collision, the authored gap absorbs growth. After collision, the target
inherits the source's full final displacement (minus movement already inherited)
so the authored gap is restored rather than consumed. Parallel lanes contribute
the deepest collision path rather than being summed. Content geometrically
contained by a Section or Box inherits that container's absolute displacement;
its own lane collision may move it farther.

**Why:** Raw growth offsets moved content even when an authored gap fully
absorbed an accordion expansion. Moving only by the visible overlap fixed that
threshold but consumed every gap after collision, making stacked panels touch
and eventually overlap. Parallel lanes must still avoid double-counting.

**How to apply:** Propagate final visible bottoms through the active
breakpoint's resolved lanes. Apply signed aspect-carousel movement as the base
position before collision checks, so upstream pushes and signed shrink/grow
compose without overlap. A displaced non-auto content block becomes a
zero-growth collision relay; displaced Section and Box backgrounds relay too,
but ownership prevents their children from inheriting movement twice. Size
containers and the stage from final rendered bottoms. Infer container ownership
from the active breakpoint's stored rectangle, never from full-width/full-bleed
rendering reach. Auto-height content whose top anchor is inside a Section may
remain owned when its bottom crosses the Section edge, but only with full
horizontal containment. Box ownership always requires full-rectangle
containment. Mixed nested Sections/Boxes use the smallest owner and inherit each
container displacement once. Signed aspect carousels keep their residual
collision exception. Editor displacement remains zero.