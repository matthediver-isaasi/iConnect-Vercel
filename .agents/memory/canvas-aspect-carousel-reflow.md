---
name: Aspect-carousel reflow reference
description: Public signed reflow for aspect-height Hero Carousels must reference the aspect-derived height at the stage width, not stored geometry h.
---

# Aspect-height Hero Carousel reflow reference

Rule: for aspect-mode Hero Carousels (height:auto + CSS aspect-ratio), the public signed reflow's reference height must be the aspect-derived height at the breakpoint STAGE width (1200/768/375; fullBleed/fullWidth → stage width, otherwise the stage-clamped stored width, min/max clamps applied) — never the stored per-breakpoint geometry `h`.

**Why:** the stored h is only a snapshot and drifts from what the editor stage renders (wrapper is height:auto). Authors align blocks below with the VISIBLE aspect bottom, so measuring growth from stored h double-counts the mismatch as a constant gap (or overlap) below the carousel on every viewport at that breakpoint. Real case: stored 552 vs rendered 619 at 375 → constant ~64px gap on all phones.

**Editor-side bake:** the builder also keeps STORED per-breakpoint h honest via pure `bakeAspectCarouselGeometry` (same math), triggered by a signature effect in CanvasBuilder watching ratio/clamps/width/full-bleed. The first observation only seeds the signature (no bake) so opening a drifted legacy page never flips isDirty — mirrors the auto-height author-intent gate. The bake never moves blocks below (authors already align with the visible bottom) and skips history (undo of the triggering edit re-bakes the old value).

**How to apply:** shared pure helper `resolveAspectReflowReferenceHeight` in canvasDesign.js (null → legacy fallback to stored h when no persisted ratio). Also: `getOffset` gives signed (aspect-carousel) rows a small push-slack (12px) because authors drag flush blocks a few px short of the exact aspect bottom; strict `refBottom <= storedY` would skip exactly those blocks. Push-down-only rows keep the strict test.
