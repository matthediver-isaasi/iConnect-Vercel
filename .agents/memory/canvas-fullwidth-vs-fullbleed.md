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

**Inner content rail (align bleed content to the page column):** a full-bleed bar spans 100vw, but its inner content (ticker label/text, mega-menu row, section content) should re-align to the centered content column, not sit flush at the viewport edge. The stage stylesheet (`buildCanvasCss`) publishes `--cb-content-width` on `.canvas-stage` per breakpoint (1200/768/375), declared on EVERY stage rule incl. both tablet/mobile media branches. Because CSS custom props inherit through the DOM, the var reaches absolutely-positioned bleed blocks (still DOM children of the stage). Renderers add a centered rail only when `content.fullBleed`: `{ maxWidth:'var(--cb-content-width,1200px)', marginInline:'auto' }` on the inner full-width row. It's a no-op when not bleeding and in the editor (var absent → fallback 1200, `width:100%` caps to block width). Section uses an equivalent `railStyle` keyed off `c.maxWidth` instead.
