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
- A block only bleeds cleanly if its renderer fills its outer tag (`w-full h-full` or `absolute inset-0`). Section is special: for colour/gradient it adds its OWN inner `!asEditor` 100vw breakout on top, so don't copy section's renderer as a template. NEVER add that inner breakout to a layer that lives inside the wrapper's content box: `left:50%` resolves against (100vw − padding) while the margin is a full −50vw, shifting layers left by half the horizontal padding and leaving a right-edge gap — this is why image-background sections skip the inner breakout and rely solely on the outer geomRule breakout + negative-padding layer insets.

**`100vw` overflows fixed-width preview iframes:** in the editor's `?_bp=` preview, the iframe is sized to exactly the breakpoint width (375/768), so `100vw` should equal the stage — but `100vw` includes the iframe's classic vertical scrollbar, making full-bleed blocks overflow the stage horizontally by the scrollbar width. Fix: in forced tablet/mobile breakpoint mode use the stage-filling branch (`left:0; width:100%`) instead of the 100vw breakout; keep `100vw` only for forced desktop (whose iframe can be wider than the centred 1200px stage). The public geomRule path still emits `100vw` and has the same latent scrollbar overflow on classic-scrollbar browsers.

**Per-breakpoint style caps (Hero padding pattern):** `block.style.*` has NO per-breakpoint layer (only geometry does, via `bp.*`), so desktop-authored values like 80–120px hero padding apply verbatim on 375px stages. The fix pattern is render-time caps, never a stored transform: `Math.min` against per-breakpoint maxima when the renderer's `breakpoint` prop is tablet/mobile (covers editor stage + `?_bp=` iframe), PLUS per-block `@media` rules with `!important` for the public path (breakpoint prop is undefined there). Emit media rules only when a value exceeds the cap so untouched blocks stay byte-identical.

**Full-bleed pins editor geometry like fullWidth — toggles must snapshot on release:** `blockIsFullWidthLike()` treats `content.fullBleed` the same as `fullWidth` (x=0/w=stage pin in the editor), so the Position panel's X/Width inputs must disable for full-bleed blocks too, with a visible Full-bleed control + hint (not silently-dead inputs). Turning full-bleed OFF must first write the currently rendered x=0/w=BREAKPOINT_WIDTH into the active breakpoint frame (shared `setBlockContentFullBleed()` helper in canvasDesign.js), else the block snaps to a stale stored frame. Every content-inspector fullBleed toggle (Hero, Hero Carousel) must route through the same helper, not raw `set({fullBleed:v})`, or the two entry points drift.

**absoluteFill blocks must not get wrapper padding:** Hero/Hero Carousel renderers are `absolute inset-0` (spans the wrapper's PADDING box) and consume `block.style.padding*` internally, so wrapper padding is visually inert for them — but with `box-sizing:border-box`, a padding sum wider than the pinned width (auto-built heroes carry 200+200px vs the 375px mobile stage) force-expands the border box past the stage edge. All three block-wrapper render paths (CanvasStage, CanvasPageRenderer, SymbolChildPreview) must skip padding when `def.absoluteFill`.

**Layout engine emits contained heroes:** the doc→canvas engine's hero factory sets `fullWidth:true` + `fullBleed:false` (stops at the page column, no 100vw breakout); the spacing scanner accepts either flag as "spans the column".

**Inner content rail (align bleed content to the page column):** a full-bleed bar spans 100vw, but its inner content (ticker label/text, mega-menu row, section content) should re-align to the centered content column, not sit flush at the viewport edge. The stage stylesheet (`buildCanvasCss`) publishes `--cb-content-width` on `.canvas-stage` per breakpoint (1200/768/375), declared on EVERY stage rule incl. both tablet/mobile media branches. Because CSS custom props inherit through the DOM, the var reaches absolutely-positioned bleed blocks (still DOM children of the stage). Renderers add a centered rail only when `content.fullBleed`: `{ maxWidth:'var(--cb-content-width,1200px)', marginInline:'auto' }` on the inner full-width row. It's a no-op when not bleeding and in the editor (var absent → fallback 1200, `width:100%` caps to block width). Section uses an equivalent `railStyle` keyed off `c.maxWidth` instead.
