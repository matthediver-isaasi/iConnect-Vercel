---
name: Canvas tablet/mobile geometry clamp is display-only and shared
description: Tablet/mobile block geoms are clamped at render on ALL surfaces (editor stage, published CSS, forced-bp preview) via one shared helper; stored frames and interaction paths stay raw.
---

Rendered Canvas block geometry at tablet/mobile is clamped so `x + w` never exceeds the stage width (desktop cascade routinely yields 1200px-wide blocks on the 375px stage — a prod scan found ~2,460 such blocks; almost never a stored-wide mobile frame). The clamp applies on every render surface, not just the editor.

**Rules:**
- One shared React-free helper (`clampGeomToStage` in the canvas design lib) is used by all three render surfaces: the editor stage (also feeds snapping + marquee hit-testing and live drag previews), the published per-page @media CSS emission, and the forced-breakpoint `?_bp=` preview inline geometry. Don't fork a local copy — the surfaces must not drift.
- In the static CSS path, clamping happens BEFORE the "differs from previous breakpoint" comparison — that's what makes a desktop-cascaded over-wide block emit an override rule at all. Full-width/full-bleed blocks are exempt (geomRule pins x/w to 100%/100vw).
- The clamp only touches x/w, never y/h — so reflow/accordion push-down and stage-height calcs are unaffected.
- Drag/resize handlers, the Position inspector, alignment, and hide/show all read/write RAW per-breakpoint frames via `resolveBlockAtBreakpoint`. Never assume rendered geom equals stored geometry on tablet/mobile.

**Why:** stored geometry must never be rewritten by viewing a breakpoint; rewriting frames on render would corrupt desktop layouts and break undo/history.

**How to apply:** any new render surface (export preview, thumbnails, etc.) must apply the shared clamp; any new data path (export, autolayout) must use the raw frames.
