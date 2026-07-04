---
name: Canvas link field paths
description: Where links actually live inside canvas_design blocks, and the single-source-of-truth helper that mirrors the block registry.
---

`client/src/lib/canvasLinks.js` is the single source of truth for "where do links
live inside a canvas_design document" — used by both the Canvas Links Manager
admin page and its backend endpoint. It is React-free and imports ONLY
`BLOCK_TYPES` from `canvasDesign.js` (which itself has zero external imports), so
it is safe to import from the Vercel serverless backend via a relative path.

**Why:** link *editors* live in the block registry (`registry.jsx` /
`dynamicBlocks.jsx`), but a cross-page link manager needs the field paths without
pulling in the React registry. When a block gains a new link field, add ONE spec
entry to `LINK_FIELD_SPECS` / `HTML_FIELD_SPECS` here too, or it won't surface.

**Verified field paths (task briefs have been wrong about these — confirm in the
registry before trusting any doc):**
- Pricing table CTA lives on `content.tiers[].ctaHref` — NOT `items[]`.
- Logo strip links live on `content.logos[].href` — NOT `items[]`.
- Article-list `ctaHref` and Form `successHref` do NOT exist in the current block
  content shapes — do not extract them (phantom rows).
- Hero `content.ctas[].href`, Image/Button `content.href`, Card `content.ctaHref`,
  Speaker carousel `content.ctaHref`, Sponsor grid/carousel
  `content.emptyCatCtaHref`, Hero carousel `content.slides[].ctaLink`.
- Accordion `content.items[].links[].url`; Mega menu `content.items[].href` +
  `content.items[].columns[].links[].href` + `content.items[].featuredHref`.
- Rich-text html fields (text/columns/accordion answer/card body/testimonials/
  card-flip-grid/hero-carousel slide text/custom-html) contain inline `<a href>`
  anchors, addressed by document-order `anchorIndex` (backend has no DOM, so
  extraction and rewrite both iterate `<a` opening tags in the same order).

**How to apply:** blocks are addressed by stable `block.id`; the traversal walks
`design.root.sections[].children[]` recursively (including nested `block.children`).
Apply is done on a deep clone and re-validated (version/root/sections) before persist.
