---
name: Canvas V1 box public grow-only floor
description: Why the V1 public renderer floors decorative Box height at the authored/stored value while the editor bake does not.
---

# V1 Canvas Box: public renderer is grow-only, editor bake is not

A decorative Box (V1 absolute-position canvas) re-anchors its height to the
deepest contained MEASURED content via `computeReanchoredBoxHeight`. That shared
formula can return LESS than the box's authored/stored height whenever contained
auto-height text renders shorter than its stored geometry.

**Rule:** the V1 **public** renderer must keep a Box grow-only, but runtime growth
is geometric: consume the authored room inside the Box and grow only by the
amount a contained block's final visible bottom crosses the Box bottom. The
**editor bake** keeps its authored-inset re-anchor so persisted edits can still
reverse a prior grow.

**Why:** the grow-only floor prevents public/editor drift below the authored
height, while preserving the old bottom inset at runtime made a small content
increase grow the Box even when all visible content still fit inside it.

**How to apply:** calculate public Box growth from final contained bottoms
relative to the moved Box bottom and floor at zero. Keep card rows excluded.
Do not change the editor's `computeReanchoredBoxHeight` behavior as part of
public collision reflow.

**V2 (flow) note:** `canvasFlowLayout.js` (`layoutFreeChildren`) has the same
below-authored shrink math, but V2 uses ONE shared layout for builder + public, so
there is no builder/public drift there. Whether V2 should also honour
"never below authored" is a separate product decision, not a drift bug.
