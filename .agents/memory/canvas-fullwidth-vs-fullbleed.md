---
name: Canvas Builder full-width vs full-bleed
description: Two distinct "make it wide" mechanisms in /canvasbuilder and which one truly spans the screen.
---

The Canvas Builder has TWO independent width mechanisms that look similar but differ:

- **Full width** (`block.fullWidth`, generic Position-section toggle, any block): `width:100%; left:0`. Only fills the centered design **stage** (its `max-width` = the desktop breakpoint, `margin:0 auto`). On viewports wider than the stage it stops at the stage edge — it does NOT reach the screen edges.
- **Full-bleed** (`block.content.fullBleed`): `width:100vw; left:50%; transform:translateX(-50%)` — true viewport-edge breakout.

**Why this matters:** users expect "full width" on hero/ticker/menu blocks to span the screen; it won't unless full-bleed is used.

**How to apply:**
- Which block types may bleed is a single allow-list: `FULL_BLEED_BLOCK_TYPES` / `blockSupportsFullBleed()` in canvasDesign.js. Add a type there to enable it (and add a `fullBleed:false` content default + a Full-bleed toggle in that block's inspector).
- The gate is consumed by TWO render paths that must stay in sync: the static stylesheet generator (geomRule callers) AND CanvasPageRenderer's forced-breakpoint path. Both already call the helper, so adding a type Just Works.
- `fullBleed` is checked before `fullWidth`, so bleed wins when both are set.
- A block only bleeds cleanly if its renderer fills its outer tag (`w-full h-full` or `absolute inset-0`). Section is special: it adds its OWN inner `!asEditor` 100vw breakout on top, so don't copy section's renderer as a template.
