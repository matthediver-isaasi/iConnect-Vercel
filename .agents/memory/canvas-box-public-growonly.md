---
name: Canvas V1 box public grow-only floor
description: Why the V1 public renderer floors decorative Box height at the authored/stored value while the editor bake does not.
---

# V1 Canvas Box: public renderer is grow-only, editor bake is not

A decorative Box (V1 absolute-position canvas) re-anchors its height to the
deepest contained MEASURED content via `computeReanchoredBoxHeight`. That shared
formula can return LESS than the box's authored/stored height whenever contained
auto-height text renders shorter than its stored geometry.

**Rule:** the V1 **public** renderer (`AccordionReflowContext.getContainerGrowth`)
must be **grow-only** — floor the growth delta at 0 via `computeBoxGrowthDelta =
max(0, reanchored − storedHeight)`. Never let a published box render shorter than
the author drew it. The **editor bake** (`planAutoHeightBake`) keeps using the raw
un-floored `computeReanchoredBoxHeight` so it can still reverse a prior grow.

**Why:** the CanvasBuilder shows a Box at its stored geometry (editorMode keeps
containers rigid, growth = 0). If the public path shrinks below stored, the
published page drifts from the builder — e.g. a box authored at 300px collapsed to
its ~214px text height on the front-end while the builder still showed 300px. On
the public path box growth is runtime (never persisted), so "shrink back after a
grow" (the #2583 intent) just means returning to the stored/authored height — the
grow-only floor already does exactly that. This is an intentional policy split, not
strict same-output parity: bake may persist a shrink, public floors at stored.

**How to apply:** any change to box auto-sizing on the front-end must preserve the
grow-only floor. Do NOT push the floor into `computeReanchoredBoxHeight` itself —
the editor bake depends on it returning < stored.

**V2 (flow) note:** `canvasFlowLayout.js` (`layoutFreeChildren`) has the same
below-authored shrink math, but V2 uses ONE shared layout for builder + public, so
there is no builder/public drift there. Whether V2 should also honour
"never below authored" is a separate product decision, not a drift bug.
