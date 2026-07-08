---
name: Canvas mobile stage clamp is display-only
description: Editor tablet/mobile block geoms are clamped for rendering; stored frames and interaction paths stay raw, and the public CSS path has no clamp.
---

The CanvasBuilder editor stage clamps resolved block geometry at tablet/mobile so `x + w` never exceeds the stage width (desktop cascade routinely yields 1200px-wide blocks on the 375px stage — a prod scan found ~2,460 such blocks; almost never a stored-wide mobile frame).

**Rules:**
- The clamp is display-only, applied where the stage resolves geoms for rendering (also feeds snapping + marquee so hit-testing matches visuals) and re-applied to live preview geoms mid-drag.
- Drag/resize handlers, the Position inspector, alignment, and hide/show all read/write RAW per-breakpoint frames via `resolveBlockAtBreakpoint`. Never assume the stage's rendered geom equals stored geometry on tablet/mobile.
- The public CSS path (`geomRule` / per-page @media emission) does NOT clamp — real phone visitors can still get overflowing blocks (follow-up exists).

**Why:** stored geometry must never be rewritten by viewing a breakpoint; rewriting frames on render would corrupt desktop layouts and break undo/history.

**How to apply:** any new editor surface that positions overlays/handles off block geometry must use the same clamped geoms as the stage; any new data path (export, autolayout) must use the raw frames.
