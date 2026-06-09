---
name: Canvas Builder full-width vs full-bleed
description: Two distinct "make it wide" mechanisms in /canvasbuilder and which one truly spans the screen.
---

The Canvas Builder has TWO independent width mechanisms that look similar but differ:

- **Full width** (`block.fullWidth`, generic Position-section toggle, any block): geomRule emits `width:100%; left:0`. This only fills the centered design **stage**, whose `max-width` is `BREAKPOINT_WIDTHS.desktop` with `margin:0 auto` (canvasDesign.js stage rule). On viewports wider than the stage it stops at the stage edge — it does NOT reach the screen edges.
- **Full-bleed** (`block.content.fullBleed`): geomRule emits `width:100vw; left:50%; transform:translateX(-50%)` — true viewport-edge breakout.

**Why this matters:** users expect a Hero "full width" to span the screen; it won't unless full-bleed is used.

**How to apply:** The full-bleed gate lives in `geomRule(...)` callers in `canvasDesign.js` (3 spots: desktop/tablet/mobile) AND duplicated in `CanvasPageRenderer.jsx` (forced-breakpoint `forcedStyle` path + the `data-full-bleed` attr). Any change to which block types can bleed must be made in BOTH files or the editor preview and public page diverge. `SectionRender` additionally applies its own `!asEditor` 100vw breakout on the inner wrapper; `HeroRender` does not (it's `absolute inset-0`, so it just fills the outer tag geomRule sizes). In geomRule, `fullBleed` is checked before `fullWidth`, so bleed wins when both are set.
